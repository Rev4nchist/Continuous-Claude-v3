/**
 * Automatic session names (Session identity Phase 1, item B).
 *
 * session-register picks one animal word at SessionStart when a session has no name,
 * writes it to the identity file and returns it as hookSpecificOutput.sessionTitle.
 * /rename and --name always win. Nothing here throws: a naming fault must never break a start.
 *
 * Canonical word list: AUTO_WORDS in scripts/coordination/session-label.mjs. WORDS is a copy
 * (hooks do not import scripts/), and session-names.test.ts asserts the two are equal.
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isHeadless, laneCliCmd, resolveBoard } from './lane-board.js';
import { identityDir, label, normCwd, readIdentity, type Identity } from './session-identity.js';

export const WORDS: readonly string[] = (
  'otter heron lynx puffin marten osprey ibex koala lemur bison crane egret finch gecko hyena kestrel ' +
  'llama moose narwhal ocelot panda quail stoat tapir walrus yak zebra badger beaver dingo ermine ferret ' +
  'gibbon impala jaguar kiwi magpie newt orca pika robin shrew sloth tern toad wombat wren vole'
).split(' ');

/** A file with no endedAt older than this is a session that died without a SessionEnd. */
export const DEGRADED_WINDOW_MS = 7 * 24 * 3600_000;
/** The same-name startup hint looks only at identity files this fresh. */
export const HINT_WINDOW_MS = 6 * 3600_000;

const lc = (s: string): string => s.trim().toLowerCase();
const WORD_RE = new RegExp(`^(?:${WORDS.join('|')})2?$`);

/** A list word, or "<word>2" (the pick when all 48 are held), in any case. */
export function isAutoName(name: string | null | undefined): boolean {
  return typeof name === 'string' && WORD_RE.test(lc(name));
}

/** FNV-1a over the uuid: a stable start index, so one uuid always starts at one word. */
function startIndex(uuid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < uuid.length; i++) {
    h ^= uuid.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % WORDS.length;
}

/** Start at hash(uuid) mod 48, walk forward past held words. All held: "<word>2". `held` is lowercase. */
export function pickName(uuid: string, held: ReadonlySet<string>): string {
  const start = startIndex(uuid);
  for (let i = 0; i < WORDS.length; i++) {
    const w = WORDS[(start + i) % WORDS.length];
    if (!held.has(w)) return w;
  }
  return `${WORDS[start]}2`;
}

/**
 * Headless runs (`claude -p`, entrypoint sdk-cli, sdk-ts, sdk-py) get no name: 144 of 151
 * transcripts since 2026-11-02 were headless and would use up the list. CCV3_AUTONAME=1 forces
 * a name, =0 turns naming off. Gate on the entrypoint, not isInteractive (false on desktop).
 */
export function autoNameAllowed(env: Record<string, string | undefined> = process.env): boolean {
  if (env.CCV3_AUTONAME === '0') return false;
  if (env.CCV3_AUTONAME === '1') return true;
  return !String(env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk');
}

/** lowercase name -> uuids that hold it. */
export type HeldMap = Map<string, string[]>;

function addHeld(map: HeldMap, id: Identity | null, uuid: string): void {
  if (!id?.name || id.endedAt) return;
  const k = lc(id.name);
  map.set(k, [...(map.get(k) ?? []), uuid]);
}

/** Names held by these live sessions: the file has a name and no endedAt. A missing file holds nothing. */
export function heldFromLive(ids: readonly string[], read: (uuid: string) => Identity | null = readIdentity): HeldMap {
  const map: HeldMap = new Map();
  for (const uuid of ids) {
    try { addHeld(map, read(uuid), uuid); } catch { /* one bad file holds nothing */ }
  }
  return map;
}

/**
 * No DB: every identity file with no endedAt and an mtime in the last 7 days. `exclude` drops the
 * session itself. A missing folder holds nothing.
 */
export function heldDegraded(now: number = Date.now(), exclude: readonly string[] = []): HeldMap {
  const map: HeldMap = new Map();
  try {
    const dir = identityDir();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const uuid = f.slice(0, -5);
      if (exclude.includes(uuid)) continue;
      try {
        if (now - statSync(join(dir, f)).mtimeMs > DEGRADED_WINDOW_MS) continue;
        addHeld(map, readIdentity(uuid), uuid);
      } catch { /* a file that vanished or is unreadable holds nothing */ }
    }
  } catch { /* no identity folder yet */ }
  return map;
}

/** The held names as a lowercase set, leaving out whatever `except` holds. */
export function namesHeld(map: HeldMap, except?: string | null): Set<string> {
  const out = new Set<string>();
  for (const [name, holders] of map) if (holders.some((h) => h !== except)) out.add(name);
  return out;
}

export interface ChooseInput {
  uuid: string;
  source?: string;
  /** The payload or the transcript already gives a name (--name, /rename): never override it. */
  named: boolean;
  /** The name this uuid's own identity file already holds. */
  ownName: string | null;
  previousId: string | null;
  previousName: string | null;
  /** fork: the parent has ended, or its sessions row is quiet. Unknown counts as not quiet. */
  previousQuiet: boolean;
  /** Names held by live sessions other than this one. The previous session is among them while it is live. */
  held: HeldMap;
}

/**
 * The selection rule. Returns the name to set, or null for "set nothing".
 *   named / compact -> null;  own name -> keep it;
 *   resume or clear -> carry the previous name, unless a session other than `previous` holds it;
 *   fork            -> same, but only from a quiet parent (two live sessions with one name break `say --to`);
 *   otherwise       -> pick a free word.
 */
export function chooseName(c: ChooseInput): string | null {
  if (c.named || c.source === 'compact') return null;
  if (c.ownName) return c.ownName;
  const carries = c.source === 'resume' || c.source === 'clear' || (c.source === 'fork' && c.previousQuiet);
  if (carries && c.previousName && !namesHeld(c.held, c.previousId).has(lc(c.previousName))) return c.previousName;
  return pickName(c.uuid, namesHeld(c.held));
}

/**
 * Report only, never move lanes: `claude --name foo` while an earlier session named foo never
 * ended in this cwd. Exactly one fresh unended twin gives one line. No DB, identity files only.
 * A list word gives nothing: adoptAllowed refuses a same-name adopt for those.
 */
export function sameNameHint(
  uuid: string,
  name: string | null | undefined,
  cwd: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!name || !cwd || isAutoName(name)) return null;
  const want = lc(name);
  const twins: Identity[] = [];
  try {
    const dir = identityDir();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f.slice(0, -5) === uuid) continue;
      try {
        if (Math.abs(now - statSync(join(dir, f)).mtimeMs) > HINT_WINDOW_MS) continue;
        const id = readIdentity(f.slice(0, -5));
        if (!id || id.endedAt || !id.name || lc(id.name) !== want) continue;
        if (!id.cwd || normCwd(id.cwd) !== normCwd(cwd)) continue;
        const at = Date.parse(id.updatedAt);
        if (!Number.isFinite(at) || Math.abs(now - at) > HINT_WINDOW_MS) continue;
        twins.push(id);
      } catch { /* skip one bad file */ }
    }
  } catch { /* no identity folder yet */ }
  if (twins.length !== 1) return null;
  const t = twins[0];
  return `${label(t.uuid, t.name)} in this cwd never ended. If it crashed, run: ${laneCliCmd()} adopt --from ${t.uuid} once it is quiet 5 min.`;
}

/**
 * One line for the SessionStart banner: which lane board this folder uses. Headless sessions get no line (they get no
 * board). Reads the registry only; no database call. Fails to an empty string.
 */
export function laneBoardLine(
  cwd: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  try {
    if (isHeadless(env)) return '';
    const b = resolveBoard(cwd || process.cwd(), { env });
    return b ? `lane board: ${b.key}` : 'no lane board (unregistered dir)';
  } catch {
    return '';
  }
}
