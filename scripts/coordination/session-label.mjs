/**
 * session-label -- the one way to write a session as text: "<name> #<sid8>".
 *
 * The identity file is the contract between every surface (hooks, lane.mjs, the
 * statusline launcher, the band):
 *
 *   ~/.claude/state/identity/<uuid>.json
 *   { uuid, short, name, previous, cwd, endedAt, endReason, updatedAt }
 *
 * Folder override for tests: CCV3_IDENTITY_DIR. Readers treat a missing or
 * corrupt file as absent. Writers merge and write atomically (tmp file in the
 * same folder, then rename), so a reader never sees half a file.
 *
 * Pure node, no dependencies. lane.mjs imports it. The hooks do NOT: they carry a TS
 * port of the same rules in .claude/hooks/src/shared/session-identity.ts, so a change
 * to the dir rule, the SAFE id rule or the name clip here needs the same change there.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Name display clip, in characters. */
export const NAME_CLIP = 16;

export const short = (uuid) => (uuid ? String(uuid).slice(0, 8) : '--------');

export function identityDir() {
  return process.env.CCV3_IDENTITY_DIR || join(homedir(), '.claude', 'state', 'identity');
}

/** A uuid becomes a file name, so refuse anything that could leave the folder. */
const SAFE_ID = /^[0-9a-fA-F-]{8,64}$/;
export const isSafeId = (u) => !!u && SAFE_ID.test(String(u));

/** An agent type that --agent may carry into an event: letters, digits, _ and -. */
const SAFE_AGENT = /^[A-Za-z0-9_-]{1,40}$/;
export const validAgent = (a) => (typeof a === 'string' && SAFE_AGENT.test(a) ? a : null);

export function readIdentity(uuid, dir = identityDir()) {
  if (!isSafeId(uuid)) return null;
  try {
    const v = JSON.parse(readFileSync(join(dir, `${uuid}.json`), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Every readable identity file, as a Map keyed by uuid. Corrupt files are skipped. */
export function listIdentities(dir = identityDir()) {
  const out = new Map();
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const uuid = f.slice(0, -'.json'.length);
    const id = readIdentity(uuid, dir);
    // The file name is the identity. A uuid inside the content must not redirect a lookup.
    if (id) out.set(uuid, { ...id, uuid });
  }
  return out;
}

export const clipName = (n) => String(n).replace(/\s+/g, ' ').trim().slice(0, NAME_CLIP);

/**
 * "name #sid8", or "#sid8" with no name. `ids` is the Map from listIdentities();
 * leave it out to read the one file.
 */
export function label(uuid, ids) {
  const id = ids ? ids.get(uuid) : readIdentity(uuid);
  const name = id && typeof id.name === 'string' ? clipName(id.name) : '';
  return name ? `${name} #${short(uuid)}` : `#${short(uuid)}`;
}

/**
 * The sender of an event: "name/agent #sid8", "#sid8 (agent)" with no name, or the
 * plain label with no valid agent. A subagent shares its parent's session uuid, so
 * the agent type is the only thing that tells them apart.
 */
export function labelWithAgent(uuid, ids, agent) {
  const a = validAgent(agent);
  if (!a) return label(uuid, ids);
  const id = ids ? ids.get(uuid) : readIdentity(uuid);
  const name = id && typeof id.name === 'string' ? clipName(id.name) : '';
  return name ? `${name}/${a} #${short(uuid)}` : `#${short(uuid)} (${a})`;
}

/**
 * Merge `patch` into the identity file and write it atomically. A key left out
 * of `patch` (or set to undefined) keeps its stored value, so a writer that only
 * knows the name cannot drop `previous` or `endedAt`. A key set to null clears it.
 */
export function writeIdentity(uuid, patch = {}, dir = identityDir()) {
  if (!isSafeId(uuid)) throw new Error(`bad session id "${uuid}"`);
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = {
    uuid: String(uuid), short: short(uuid),
    name: null, previous: null, cwd: null, endedAt: null, endReason: null,
    ...(readIdentity(uuid, dir) || {}),
    ...set,
    uuid: String(uuid), short: short(uuid),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${uuid}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, join(dir, `${uuid}.json`));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return next;
}

/**
 * Which session does `name` mean? Exact match, any case, among `liveUuids`.
 * A session that another identity file names as `previous` is the old half of a
 * /clear, resume or fork: drop it. Returns the matching uuids, newest first by
 * `updatedAt`. One entry is the answer. Several are an ambiguity the caller reports.
 */
export function resolveName(name, ids, liveUuids) {
  const want = String(name).trim().toLowerCase();
  const replaced = new Set([...ids.values()].map((i) => i.previous).filter(Boolean));
  return [...liveUuids]
    .filter((u) => {
      const id = ids.get(u);
      return id && typeof id.name === 'string' && id.name.trim().toLowerCase() === want
        && !id.endedAt && !replaced.has(u);
    })
    .sort((a, b) => String(ids.get(b).updatedAt).localeCompare(String(ids.get(a).updatedAt)));
}

/**
 * May `newUuid` take over what `oldUuid` held? Yes when both identity files carry
 * the same non-empty name, or when the new file names the old uuid as `previous`.
 * No otherwise: adopt moves another session's lanes, so a stranger gets nothing.
 */
export function adoptAllowed(oldUuid, newUuid, oldId, newId) {
  if (!oldUuid || !newUuid || oldUuid === newUuid) return false;
  if (newId && newId.previous === oldUuid) return true;
  const a = oldId && typeof oldId.name === 'string' ? oldId.name.trim().toLowerCase() : '';
  const b = newId && typeof newId.name === 'string' ? newId.name.trim().toLowerCase() : '';
  return a !== '' && a === b;
}
