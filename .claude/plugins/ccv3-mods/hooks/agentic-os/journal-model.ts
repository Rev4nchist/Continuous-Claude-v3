import { oneLine } from './text'
import type { WorkflowFeed } from './workflow-model'

// The workflow journal behind the Swarm tab (design 4b). Pure: no engine, no clock, no disk. The caller reads the files and hands in their text,
// so a test needs no fake file system. Nothing here throws: a bad text gives null.
//
// Two files per run, both under ~/.claude/projects/<slug>/<session id>/ (measured 2026-10-30):
//   subagents/workflows/<run id>/journal.jsonl   one JSON object per line, written while the run goes on:
//                                                `{type:'launched'}`, `{type:'started', key, agentId, label, phase}`, `{type:'result', key, agentId, result, toolsUsed}`.
//                                                It holds no run id, no workflow name, no phase index and no total.
//   workflows/<run id>.json                      written when the run ends: `runId`, `workflowName`, `phases[]`, and `workflowProgress[]`.
// From the journal this reads the `started` lines only, and from them agentId, label and phase. The phase index is the order of first appearance
// of a phase title, from 1; the total is null (the journal never says how many phases a script has). From the run file it reads `runId`,
// `workflowName` and the number of `phases`. It never reads a prompt or a result: not `promptPreview` or `resultPreview` of the run file's
// `workflowProgress`, not `result` or `toolsUsed` of the journal, not the `key`. Every string is redacted, made one line and clipped.
// Observer only.

/** A file over this many characters is not read: the engine rejects 4 MiB, and a journal of a long run is a few tens of KB. */
export const JOURNAL_MAX_BYTES = 1_000_000
/** A label or a run name; a phase title. Longer text ends with an ellipsis. */
export const LABEL_MAX = 80
export const PHASE_MAX = 60
/** The feed keeps this many helpers and phases of one run; the rest is dropped, never summed into a total. */
const MAX_AGENTS = 500
const MAX_PHASES = 50

/** A run id as the engine writes it (`wf_12341338-74d`). Anything else could name another folder. */
const RUN_ID = /^wf_[A-Za-z0-9-]{1,64}$/
/** One folder name: no dot, no separator. The session id and the project slug pass it. */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,255}$/
/** A helper id, as a record key: letters, digits, hyphen and underscore, and not a name Object.prototype owns (`__proto__`, `constructor`). */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const isRunId = (value: unknown): value is string => typeof value === 'string' && RUN_ID.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const parseObject = (text: string): Record<string, unknown> | null => {
  try {
    const found: unknown = JSON.parse(text)
    return isRecord(found) ? found : null
  } catch {
    return null
  }
}

/** The folder name Claude Code gives a working folder: every character that is not a letter or a digit becomes a hyphen. */
export const projectSlug = (path: string): string => path.replace(/[^A-Za-z0-9]/g, '-')

const projectsDir = (home: string, slug: string, sessionId: string): string | null =>
  SAFE_NAME.test(slug) && SAFE_NAME.test(sessionId) ? `${home}/.claude/projects/${slug}/${sessionId}` : null

/** The journal of one run, or null when the slug, the session id or the run id could leave the session folder. */
export const journalPath = (home: string, slug: string, sessionId: string, runId: string): string | null => {
  const dir = projectsDir(home, slug, sessionId)
  return dir !== null && isRunId(runId) ? `${dir}/subagents/workflows/${runId}/journal.jsonl` : null
}

/** The file a run leaves when it ends, or null as for journalPath. */
export const runFilePath = (home: string, slug: string, sessionId: string, runId: string): string | null => {
  const dir = projectsDir(home, slug, sessionId)
  return dir !== null && isRunId(runId) ? `${dir}/workflows/${runId}.json` : null
}

/**
 * The feed of one run from its journal text: a label and a phase index per helper (by the helper's id), and the highest phase seen.
 * Null when the run id is not `wf_<id>`, the text is over the cap, or no `started` line gives a usable label or phase. A line that is not JSON,
 * not an object, not a `started` line or lacks its fields is skipped; the lines around it still count. A retry of one helper id keeps the last label.
 */
export const parseJournal = (text: string, runId: string): WorkflowFeed | null => {
  if (!isRunId(runId) || typeof text !== 'string' || text.length > JOURNAL_MAX_BYTES) return null
  const labels: Record<string, string> = {}
  const agentPhases: Record<string, number> = {}
  const titles: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const entry = raw.trim() === '' ? null : parseObject(raw)
    const id = entry?.type === 'started' ? entry.agentId : undefined
    if (entry === null || typeof id !== 'string' || !AGENT_ID.test(id) || id in Object.prototype) continue
    if (!seen.has(id) && seen.size >= MAX_AGENTS) continue
    const label = oneLine(entry.label, LABEL_MAX)
    const title = oneLine(entry.phase, PHASE_MAX)
    const known = title === '' ? -1 : titles.indexOf(title)
    if (title !== '' && known < 0 && titles.length < MAX_PHASES) titles.push(title)
    const index = title === '' ? -1 : titles.indexOf(title)
    if (label === '' && index < 0) continue
    seen.add(id)
    if (label !== '') labels[id] = label
    if (index >= 0) agentPhases[id] = index + 1
  }
  if (seen.size === 0) return null
  const phase = titles.length === 0 ? null : { index: titles.length, total: null, title: titles[titles.length - 1] ?? null }
  return { runId, name: null, phase, labels, agentPhases }
}

/** What the run file adds: the workflow's name and how many phases its script has. Each is null when the file does not say. Null for a text that is not this run's file. */
export const parseRunFile = (text: string, runId: string): { name: string | null; total: number | null } | null => {
  if (!isRunId(runId) || typeof text !== 'string' || text.length > JOURNAL_MAX_BYTES) return null
  const file = parseObject(text)
  if (file === null || file.runId !== runId) return null
  const phases = file.phases
  return {
    name: oneLine(file.workflowName, LABEL_MAX) || null,
    total: Array.isArray(phases) && phases.length > 0 && phases.length <= MAX_PHASES ? phases.length : null,
  }
}

/**
 * The feed of one run from the text of its journal and of its run file; each is null when the file could not be read. The journal gives the
 * helpers and the phase; the run file gives the name and the total, and a total below the phase already seen is dropped. No feed when neither file says anything.
 */
export const workflowFeed = (runId: string, journal: string | null, runFile: string | null): WorkflowFeed | null => {
  const base = journal === null ? null : parseJournal(journal, runId)
  const meta = runFile === null ? null : parseRunFile(runFile, runId)
  if (meta === null) return base
  if (base === null) return meta.name === null ? null : { runId, name: meta.name, phase: null, labels: {}, agentPhases: {} }
  const total = meta.total !== null && base.phase !== null && meta.total >= base.phase.index ? meta.total : null
  return { ...base, name: meta.name, phase: base.phase === null ? null : { ...base.phase, total } }
}
