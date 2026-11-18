/**
 * The "FleetOps data is stale" line, for lane-board-stop-gate.
 *
 * Twin of the refresh doc in scripts/coordination/export-dash-data.mjs (buildRefreshDoc, clearRefreshPending).
 * The hook does not import that file: it opens a database client. The drift test in
 * __tests__/lane-dash-refresh.test.ts runs both and fails if the field names move.
 *
 * State dir: ~/.claude/state/lane-dash (LANE_DASH_STATE_DIR overrides it, for tests). Nothing sweeps this dir.
 *   refresh.json         {pending, key, exported_at, ...}  written by the export, cleared by --clear-refresh
 *   .refresh-shown.json  {key, shown_at}                   written here: the hourly throttle, one per machine
 *   publish.json         {state, session, key, at, step?}  written by the fleetops-refresh lock (fleetops-html.mjs --lock-*)
 *
 * Stale = refresh.json says pending === true, OR exported_at is over STALE_AFTER_HOURS old.
 * A missing, empty or corrupt refresh.json says nothing.
 * Failed = publish.json says state 'failed' for the same non-empty key as refresh.json. It wins over pending and age, and it shows
 * when refresh.json is not stale (a forced refresh of unchanged data failed). A missing, corrupt, oversized or other-key publish.json adds nothing.
 * The failed line has its own marker key, so a pending line shown a minute ago does not hide it.
 * Show the line when the throttle marker is missing, holds another key, or is over one hour old.
 * The marker is written when the line is added. A failed write drops the line (fail open, silent).
 * The write is atomic (temp file, then rename). A marker that is a symlink is never written through.
 * A file over MAX_BYTES is not read: refresh.json then says nothing, and the marker counts as missing.
 */
import * as fs from 'fs';
import * as path from 'path';

type Env = Record<string, string | undefined>;

/** Source of truth: scripts/coordination/lane-dash.config.json `stale_after_hours`. A drift test compares them. */
export const STALE_AFTER_HOURS = 36;
export const SHOW_EVERY_MS = 60 * 60 * 1000;
export const REFRESH_FILE = 'refresh.json';
export const MARKER_FILE = '.refresh-shown.json';
export const PUBLISH_FILE = 'publish.json';
/** Both files are small JSON. A bigger file is not read. */
export const MAX_BYTES = 65536;
const CHICAGO = 'America/Chicago';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface Refresh {
  pending: boolean;
  key: string;
  /** ISO text of the export time, or null when absent or not a date. */
  exportedAt: string | null;
}

export interface PublishFailed {
  key: string;
  /** ISO text of the failure time. */
  at: string;
  /** A short step number such as '7' or '7.3', or null when absent or not in that form. */
  step: string | null;
}

export interface Marker {
  key: string;
  shown_at: string;
}

export function laneDashDir(env: Env = process.env): string {
  if (env.LANE_DASH_STATE_DIR) return env.LANE_DASH_STATE_DIR;
  const home = env.HOME || env.USERPROFILE || '';
  return path.join(home, '.claude', 'state', 'lane-dash');
}

/** Parse refresh.json text. Null for empty, corrupt or non-object text. Only the boolean `true` is pending. */
export function parseRefresh(text: string): Refresh | null {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(d)) return null;
  const at = typeof d.exported_at === 'string' && !Number.isNaN(Date.parse(d.exported_at)) ? d.exported_at : null;
  const key = typeof d.key === 'string' ? d.key : '';
  return { pending: d.pending === true, key, exportedAt: at };
}

const STEP_RE = /^\d{1,2}(\.\d{1,2})?$/;

/** Parse publish.json text. Null unless it says state 'failed' with a string key and a parseable time. The step is kept only as a short step number. */
export function parsePublishFailed(text: string): PublishFailed | null {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(d) || d.state !== 'failed' || typeof d.key !== 'string' || typeof d.at !== 'string' || Number.isNaN(Date.parse(d.at))) return null;
  const raw = typeof d.step === 'string' || typeof d.step === 'number' ? String(d.step) : '';
  return { key: d.key, at: d.at, step: STEP_RE.test(raw) ? raw : null };
}

/** Why the data is stale: 'pending' wins over 'age'. Null when it is not stale. */
export function staleKind(r: Refresh, now: number): 'pending' | 'age' | null {
  if (r.pending) return 'pending';
  if (r.exportedAt === null) return null;
  return now - Date.parse(r.exportedAt) > STALE_AFTER_HOURS * 3_600_000 ? 'age' : null;
}

/** "Nov 8, 2:53 PM CST" in America/Chicago (CST or CDT, by the date). */
export function formatChicago(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).formatToParts(new Date(iso));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('month')} ${p('day')}, ${p('hour')}:${p('minute')} ${p('dayPeriod')} ${p('timeZoneName')}`;
}

/** The one-line notice, or '' when the data is not stale. */
export function staleLine(r: Refresh, now: number): string {
  const kind = staleKind(r, now);
  if (!kind) return '';
  const why = kind === 'pending' ? 'not uploaded' : `older than ${STALE_AFTER_HOURS} hours`;
  const when = r.exportedAt ? `exported ${formatChicago(r.exportedAt)}, ${why}` : why;
  const act = kind === 'pending'
    ? "Run the fleetops-refresh skill now (Dave's standing yes, data only). Skip it in a headless run."
    : 'Tell Dave in one line. Run the fleetops-refresh skill only if he asks.';
  return `FleetOps data is stale (${when}). ${act}`;
}

/** The failed notice. Only the time and a short step number reach the text. */
export function failedLine(f: PublishFailed): string {
  const step = f.step === null ? '' : ` (step ${f.step})`;
  return `FleetOps refresh failed at ${formatChicago(f.at)}${step}. Tell Dave in one line. Do not retry until a new export.`;
}

/** True when the marker is missing, holds another key, or is over one hour old (or in the future). */
export function shouldShow(marker: Marker | null, key: string, now: number): boolean {
  if (!marker || marker.key !== key) return true;
  const shown = Date.parse(marker.shown_at);
  if (Number.isNaN(shown)) return true;
  const age = now - shown;
  return age < 0 || age > SHOW_EVERY_MS;
}

/** The file's text, or null when it is missing or over MAX_BYTES. Throws on a read error. */
function readSmall(file: string): string | null {
  if (fs.statSync(file).size > MAX_BYTES) return null;
  return fs.readFileSync(file, 'utf8');
}

function readMarker(file: string): Marker | null {
  try {
    const text = readSmall(file);
    if (text === null) return null;
    const m = JSON.parse(text);
    return isObj(m) && typeof m.key === 'string' && typeof m.shown_at === 'string' ? { key: m.key, shown_at: m.shown_at } : null;
  } catch {
    return null;
  }
}

/** Write the marker through a temp file and a rename. Refuses a symlink. Throws on any failure; no temp file is left. */
function writeMarker(file: string, marker: Marker): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('is a symlink');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(marker));
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing more to do
    }
    throw e;
  }
}

/** The failed state of publish.json, or null: a missing, oversized or corrupt file, or any read error, says nothing. */
function readPublishFailed(dir: string): PublishFailed | null {
  try {
    const text = readSmall(path.join(dir, PUBLISH_FILE));
    return text === null ? null : parsePublishFailed(text);
  } catch {
    return null;
  }
}

/**
 * The line to append to a block reason, or ''. Writes the throttle marker before it returns a line.
 * Never throws: any failure (read, parse, write) gives ''. A failed marker write is silent.
 */
export function fleetopsLine(env: Env = process.env, now: number = Date.now()): string {
  try {
    const dir = laneDashDir(env);
    const text = readSmall(path.join(dir, REFRESH_FILE));
    const r = text === null ? null : parseRefresh(text);
    if (!r) return '';
    const published = readPublishFailed(dir);
    const failed = published !== null && r.key !== '' && published.key === r.key ? published : null;
    const line = failed ? failedLine(failed) : staleLine(r, now);
    if (!line) return '';
    const markerFile = path.join(dir, MARKER_FILE);
    const markerKey = failed ? `${r.key}:failed` : r.key;
    if (!shouldShow(readMarker(markerFile), markerKey, now)) return '';
    try {
      writeMarker(markerFile, { key: markerKey, shown_at: new Date(now).toISOString() });
    } catch {
      // Fail open and silent: the block still happens without the line.
      return '';
    }
    return line;
  } catch {
    return '';
  }
}
