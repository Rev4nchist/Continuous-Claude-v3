import type { BoardLane, FileTouch, OsLane } from '../../types'
import { oneLine } from './text'

// The read of `lane.mjs board --json` and the file overlap check. Pure: no engine, no clock (the caller passes `now`), no state.
// The shape (scripts/coordination/lane.mjs, board command): { lanes: row[], peers: { id, working_on }[], me }. A row is the lane table's
// columns; this module reads only the ones lane.mjs laneLine prints: id, title, state, owner_session_id, lease_expires_at, note, scope.
// A lane's owner leaves this module as the 8-character short id only. Every string is redacted and bounded. Observer only.

export type ParsedBoard = { mine: OsLane[]; lanes: BoardLane[] }

const SHORT_ID = 8
const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/**
 * The board, or null when `stdout` is not the `{ lanes, peers, me }` object (an array, garbage, or no `lanes` array).
 * `mine` is the lanes owned by `me` (else by `sessionId`). A lane is `live` when its owner session is in `peers`, whatever its lease says (lane.mjs RECLAIMABLE:
 * a lapsed lease on a live session means the owner is still working). `leaseLapsed` is a separate tag. A lane nobody owns is never live.
 * `now` is epoch ms.
 */
export const parseBoard = (stdout: string, sessionId: string, now: number): ParsedBoard | null => {
  let data: Record<string, unknown> | null
  try {
    data = record(JSON.parse(stdout))
  } catch {
    return null
  }
  if (data === null || !Array.isArray(data.lanes)) return null
  const me = text(data.me) ?? sessionId
  const peers = new Set((Array.isArray(data.peers) ? data.peers : []).flatMap(one => text(record(one)?.id) ?? []))
  const lanes: BoardLane[] = []
  const mine: OsLane[] = []
  for (const raw of data.lanes) {
    const row = record(raw)
    const id = oneLine(row?.id, 80)
    if (row === null || id === '') continue
    const owner = text(row.owner_session_id)
    const lease = typeof row.lease_expires_at === 'string' ? Date.parse(row.lease_expires_at) : Number.NaN
    const leaseLapsed = Number.isFinite(lease) && lease <= now
    const note = oneLine(typeof row.note === 'string' ? row.note.split(/\r?\n/)[0] : undefined)
    const scope = oneLine(row.scope)
    const title = oneLine(row.title, 200)
    const state = oneLine(row.state, 40)
    const isMine = owner !== null && owner === me
    lanes.push({
      id,
      title,
      state,
      mine: isMine,
      owner: owner === null ? null : owner.slice(0, SHORT_ID),
      live: owner !== null && peers.has(owner),
      ...(note === '' ? {} : { note }),
      ...(scope === '' ? {} : { scope }),
      leaseLapsed,
    })
    if (isMine) mine.push({ id, title, state, ...(note === '' ? {} : { note }) })
  }
  return { mine, lanes }
}

const MIN_TOKEN = 3

const slashed = (value: string): string => value.replace(/\\/g, '/')

/** A scope token as a path: slashes normalised, a leading `./` and trailing slashes removed. */
const tokenOf = (raw: string): string => slashed(raw).replace(/^\.\//, '').replace(/\/+$/, '')

/**
 * The edited or committed files a lane's free-text scope may name. Heuristic: a token (split on commas, spaces and semicolons, 3 characters
 * or more) matches a path that starts with it or that holds it as whole segments. Returns the matched paths once each, with forward
 * slashes, in file order. The caller words the result as "may", never as fact.
 */
export const laneOverlap = (scope: string | undefined, files: readonly FileTouch[]): string[] => {
  if (typeof scope !== 'string') return []
  const tokens = scope.split(/[,\s;]+/).map(tokenOf).filter(one => one.length >= MIN_TOKEN)
  if (tokens.length === 0) return []
  const out: string[] = []
  for (const file of files) {
    if (file.state === 'read' || typeof file.path !== 'string') continue
    const path = slashed(file.path)
    const wrapped = `/${path}/`
    if (!out.includes(path) && tokens.some(one => path.startsWith(one) || wrapped.includes(`/${one}/`))) out.push(path)
  }
  return out
}
