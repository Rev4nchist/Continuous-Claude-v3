/**
 * fleetops-auto-core -- pure functions for the FleetOps timed export (no I/O, no clock, no child process).
 *
 * The timed task only EXPORTS. A headless claude -p has no Artifact or ArtifactData tool, so it cannot upload.
 * `pending` in refresh.json stays true until the 7 dataset files really changed since the last upload, and an
 * interactive session (the fleetops-refresh skill) uploads. Design: .claudedocs/2026-11-09-fleetops-auto-refresh-design.md
 * (the child, ledger and prompt parts do not apply).
 *
 * The hash covers the 7 uploaded sets in a fixed order. It never covers flow or factory, and never refresh.json.
 * Time stamps that change on every export are masked first, so a re-export of the same data gives the same hash.
 * The tiles set copies the export time as text ("Nov 9, 9:03 AM CST", minute precision) into 5 rows: those stamps are masked too.
 */
import { createHash } from 'node:crypto';
import { formatChicago } from './lane-dash-metrics.mjs';

/** The 7 sets, in hash order. */
export const SET_IDS = Object.freeze(['lanes', 'tiles', 'assignments', 'projects', 'targets', 'meta', 'snapshots']);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const STAMP_TOKEN = '{{export-stamp}}';

/** The text of the export time as lane-dash-metrics writes it into tile rows, or null when `exportedAt` is not a date. */
function stampOf(exportedAt) {
  if (typeof exportedAt !== 'string' || Number.isNaN(Date.parse(exportedAt))) return null;
  return formatChicago(exportedAt);
}

/**
 * A copy of `doc` with the export time stamps masked: top-level exportedAt (every set) set to null, meta.rows[0].exported_at
 * and snapshot_at in every snapshots row set to null, and in tiles every string field of every row has the formatted stamp
 * of `exportedAt` (meta.rows[0].exported_at) replaced by a token. Other times in a tile text stay. The input is not changed.
 */
export function maskDoc(id, doc, exportedAt) {
  const out = structuredClone(doc);
  if (!out || typeof out !== 'object') return out;
  out.exportedAt = null;
  const stamp = id === 'tiles' ? stampOf(exportedAt) : null;
  if (stamp && Array.isArray(out.rows)) {
    for (const row of out.rows) {
      if (!row || typeof row !== 'object') continue;
      for (const [k, v] of Object.entries(row)) if (typeof v === 'string') row[k] = v.replaceAll(stamp, STAMP_TOKEN);
    }
  }
  if (id === 'meta' && out.rows?.[0] && typeof out.rows[0] === 'object') out.rows[0].exported_at = null;
  if (id === 'snapshots' && Array.isArray(out.rows)) {
    for (const row of out.rows) if (row && typeof row === 'object') row.snapshot_at = null;
  }
  return out;
}

/**
 * One hash for the 7 sets. `docsById` maps id to the parsed document. A missing set throws.
 * Only the 7 ids are read from the object, so flow and factory are never touched.
 */
export function hashSet(docsById) {
  const get = (id) => {
    const doc = Object.hasOwn(docsById, id) ? docsById[id] : undefined;
    if (doc === undefined || doc === null) throw new Error(`hashSet: dataset ${id} is missing`);
    return doc;
  };
  const exportedAt = get('meta').rows?.[0]?.exported_at; // the unmasked export time, for the tiles stamp
  const parts = SET_IDS.map((id) => `${id}:${sha256(JSON.stringify(maskDoc(id, get(id), exportedAt)))}`);
  return sha256(parts.join('\n'));
}

/**
 * The reason to skip this tick, or null. Order: switch, tick lock, export lock, export exit (a held export lock also exits 1).
 * The tick calls it before the export (with exportExit 0) and decide() calls it again after.
 */
export function skipReason({ switchOn, lockHeld, exportExit, exportLockHeld }) {
  if (!switchOn) return 'switch off (no auto-enabled file)';
  if (lockHeld) return 'tick lock held';
  if (exportLockHeld) return 'export lock is held'; // the export exits 1 on a held lock: name the cause, not the exit code
  if (exportExit !== 0) return `export did not finish (exit ${exportExit})`;
  return null;
}

/**
 * What the tick does after the export.
 *   skip           nothing to do (a skip cause, or no refresh key to clear)
 *   clear          the data equals the last upload: clear pending
 *   leave-pending  the data changed (or was never uploaded): an interactive session uploads
 */
export function decide(input) {
  const reason = skipReason(input);
  if (reason) return { action: 'skip', reason };
  const { refresh, lastUploadedHash, newHash } = input;
  if (lastUploadedHash && newHash && newHash === lastUploadedHash) {
    if (!refresh || !refresh.key) return { action: 'skip', reason: 'no refresh doc or key to clear' };
    return { action: 'clear', reason: 'data unchanged since the last upload' };
  }
  return { action: 'leave-pending', reason: lastUploadedHash ? 'data changed since the last upload' : 'data changed: no upload recorded yet' };
}
