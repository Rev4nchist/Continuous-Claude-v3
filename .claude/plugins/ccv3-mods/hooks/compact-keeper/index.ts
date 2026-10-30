import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { KeeperRecord, OsLane, OsPlan, OsTask, PrWatch } from '../../types'
import { addRecord, compactBlock, markerKept, openCounts } from './model'

// Compact keeper (M4). A manual /compact asks the summarizer to keep this session's plan, open tasks, lane and
// watched PRs, and to copy one marker line. Only the person's /compact: the mod never compacts by itself.
// The atoms are the Agentic OS ones (declared there under the same keys); this module only reads them, except `compactions`:
// after the compaction it records whether the summary (the first message of the result) kept the marker. The record is an observer.

const tasks = atom({ plugin: 'ccv3-mods', key: 'tasks' } as const, [] as OsTask[])
const plan = atom({ plugin: 'ccv3-mods', key: 'plan' } as const, null as OsPlan | null)
const lanes = atom({ plugin: 'ccv3-mods', key: 'lanes' } as const, null as OsLane[] | null)
const prs = atom({ plugin: 'ccv3-mods', key: 'prs' } as const, [] as PrWatch[])
/** The keeper's record of manual compactions, newest last (the /os Session tab and Overview read it). */
const compactions = atom({ plugin: 'ccv3-mods', key: 'compactions' } as const, [] as KeeperRecord[])

/** CCV3_MODS_OFF=1 turns every mod off; CCV3_MOD_KEEPER_OFF=1 this one. */
const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_MOD_KEEPER_OFF')) === '1'

export const compactKeeper = (on: On) => {
  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    // A subagent compacts its own transcript: this session's plan does not belong in it.
    if (e.agentId !== undefined || (await isOff($))) return next(e)
    const view = { plan: await read($, plan), tasks: await read($, tasks), lanes: await read($, lanes), prs: await read($, prs) }
    const sessionId = await $.session.id()
    const block = compactBlock(view, sessionId)
    // The person's own text after /compact stays first.
    const result = await next(block === null ? e : { ...e, instructions: [e.instructions, block].filter(Boolean).join('\n\n') })
    // The record has its own try/catch: a throw reaching the .catch below would call next a second time, a second compaction.
    if (block !== null && !('skip' in result)) {
      try {
        const { open, total } = openCounts(view.tasks)
        // Only the summary (the first message) counts: a kept message may hold an earlier summary's marker.
        const kept = markerKept(result.messages.slice(0, 1).map(one => one.text), sessionId, open, total)
        const at = await $.clock.now()
        await update($, compactions, list => addRecord(list, { at, sessionId, open, total, kept }))
      } catch {
        // The record is lost; the compaction stands.
      }
    }
    return result
    // A hook that throws passes the compaction on unchanged (the .catch).
  }).catch(($, e, next) => next(e))
}
