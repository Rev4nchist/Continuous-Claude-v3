import type { BoardLane, FileTouch, OsLane } from '../../types'
import { oneLine } from './text'

// The read of `lane.mjs board --json` and the file overlap check. Pure: no engine, no clock (the caller passes `now`), no state.
// The shape (scripts/coordination/lane.mjs, board command): { lanes: row[], peers: { id, working_on }[], me, me_short?, me_name? }; `me` is a plain id string. A row is the lane table's
// columns; this module reads only the ones lane.mjs laneLine prints: id, title, state, owner_session_id, lease_expires_at, note, scope,
// and owner_name (the owner's session name; a string, null for no name, or no key on an older lane.mjs).
// A lane's owner leaves this module as the 8-character short id only. Every string is redacted and bounded. Observer only.

/** `meShort` and `meName` are the board's `me_short` and `me_name` (who this session is); each key is absent when the board has no such field (an older lane.mjs). */
export type ParsedBoard = { mine: OsLane[]; lanes: BoardLane[]; meShort?: string | null; meName?: string | null }

const SHORT_ID = 8
/** A session name is shown at most this long, on every surface. */
const NAME_MAX = 16
/** The safe session id rule, the same on every surface. */
const SAFE_ID = /^[0-9a-fA-F-]{8,64}$/
const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/** The first 8 characters of a safe session id, else null. */
const shortOf = (value: unknown): string | null => (typeof value === 'string' && SAFE_ID.test(value) ? value.slice(0, SHORT_ID) : null)

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
  const who = {
    ...('me_short' in data ? { meShort: shortOf(data.me_short) } : {}),
    ...('me_name' in data ? { meName: oneLine(data.me_name, NAME_MAX) || null } : {}),
  }
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
    const ownerName = 'owner_name' in row ? { ownerName: oneLine(row.owner_name, NAME_MAX) || null } : {}
    const state = oneLine(row.state, 40)
    const isMine = owner !== null && owner === me
    lanes.push({
      id,
      title,
      state,
      mine: isMine,
      owner: owner === null ? null : owner.slice(0, SHORT_ID),
      ...ownerName,
      live: owner !== null && peers.has(owner),
      ...(note === '' ? {} : { note }),
      ...(scope === '' ? {} : { scope }),
      leaseLapsed,
    })
    if (isMine) mine.push({ id, title, state, ...(note === '' ? {} : { note }) })
  }
  return { mine, lanes, ...who }
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
