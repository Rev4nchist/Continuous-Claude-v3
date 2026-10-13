import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { OsLane, OsPlan, OsTask, PrWatch } from '../../types'
import { compactBlock } from './model'

// Compact keeper (M4). A manual /compact asks the summarizer to keep this session's plan, open tasks, lane and
// watched PRs, and to copy one marker line. Only the person's /compact: the mod never compacts by itself.
// The atoms are the Agentic OS ones (declared there under the same keys); this module only reads them.

const tasks = atom({ plugin: 'ccv3-mods', key: 'tasks' } as const, [] as OsTask[])
const plan = atom({ plugin: 'ccv3-mods', key: 'plan' } as const, null as OsPlan | null)
const lanes = atom({ plugin: 'ccv3-mods', key: 'lanes' } as const, null as OsLane[] | null)
const prs = atom({ plugin: 'ccv3-mods', key: 'prs' } as const, [] as PrWatch[])

/** CCV3_MODS_OFF=1 turns every mod off; CCV3_MOD_KEEPER_OFF=1 this one. */
const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_MOD_KEEPER_OFF')) === '1'

export const compactKeeper = (on: On) => {
  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    // A subagent compacts its own transcript: this session's plan does not belong in it.
    if (e.agentId !== undefined || (await isOff($))) return next(e)
    const block = compactBlock(
      { plan: await read($, plan), tasks: await read($, tasks), lanes: await read($, lanes), prs: await read($, prs) },
      await $.session.id(),
    )
    // The person's own text after /compact stays first.
    return next(block === null ? e : { ...e, instructions: [e.instructions, block].filter(Boolean).join('\n\n') })
    // A hook that throws passes the compaction on unchanged (the .catch).
  }).catch(($, e, next) => next(e))
}
