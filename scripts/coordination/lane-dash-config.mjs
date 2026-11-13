/**
 * lane-dash-config -- loader for lane-dash.config.json, the numbers and settings behind the lane dashboard.
 *
 * Rule (defect a): a limit is null unless the config sets a number. There is no built-in default of 3.
 * The three limits are Dave's: wip_limit, never_started_cap, dave_queue_cap. Only a finite number above 0 sets one.
 * Anything else that is not null throws, so a typo cannot silently turn a limit off or on.
 *
 * Every target row has {key, value, label, source}. The source column says where the number came from.
 * Importing this file does no I/O.
 */
import { readFileSync } from 'node:fs';

export const LIMIT_KEYS = ['wip_limit', 'never_started_cap', 'dave_queue_cap'];

const NOT_SET = 'Not set. Source: Dave. Dave picks a number, or leaves it unset. Until then nothing is marked over this limit.';

const DEFAULT_TARGETS = [
  { key: 'p0_cap', value: 5, label: 'P0 soft cap', source: 'Lane board rule (COORDINATION.md): at most 5 open P0 lanes.' },
  { key: 'wip_limit', value: null, label: 'Live work limit', source: NOT_SET },
  { key: 'never_started_cap', value: null, label: 'Cap on never-started lanes', source: NOT_SET },
  { key: 'dave_queue_cap', value: null, label: 'Cap on the Waiting-on-Dave queue', source: NOT_SET },
  { key: 'window_days', value: 7, label: 'Window in days', source: 'Page choice: the word "week" on the page.' },
  { key: 'age_edge_1', value: 1, label: 'Age edge 1 (days)', source: 'PROPOSAL for the age buckets.' },
  { key: 'age_edge_2', value: 3, label: 'Age edge 2 (days)', source: 'PROPOSAL for the age buckets.' },
  { key: 'age_edge_3', value: 7, label: 'Decide-or-drop age (days)', source: 'PROPOSAL: a never-started lane older than this needs a decision.' },
  { key: 'show_rows', value: 4, label: 'Rows per list', source: 'Page choice. The Waiting on Dave list.' },
  { key: 'project_rows', value: 4, label: 'Rows in the project list', source: 'Dave, 2026-11-08 (phone length): the Projects to done tile shows 4 rows.' },
  { key: 'category_rows', value: 9, label: 'Rows in the category list', source: 'Dave, 2026-11-13: all 9 category rows on the phone.' },
  { key: 'log_rows', value: 12, label: 'Rows in the assignment log', source: 'Page choice.' },
  { key: 'session_rows', value: 7, label: 'Rows in Who took work', source: 'Page choice.' },
  { key: 'trend_min_days', value: 7, label: 'Snapshots before trends show', source: 'PROPOSAL: a trend line needs a week of daily snapshots.' },
  { key: 'done_visible_days', value: 28, label: 'Days a Done project stays visible', source: 'Design decision 2026-11-07 (defects first, item 2): 4 weeks.' },
];

const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function normalizeRow(raw, base) {
  const key = raw.key;
  const value = raw.value === undefined ? (base ? base.value : null) : raw.value;
  if (LIMIT_KEYS.includes(key)) {
    if (value !== null && !isPositiveNumber(value)) throw new Error(`${key}: must be null (unset) or a number above 0, got ${JSON.stringify(value)}`);
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key}: must be a finite number, got ${JSON.stringify(value)}`);
  }
  return {
    key,
    value,
    label: typeof raw.label === 'string' && raw.label ? raw.label : (base?.label ?? key),
    source: typeof raw.source === 'string' && raw.source ? raw.source : (base?.source ?? 'Set in lane-dash.config.json.'),
  };
}

function positive(raw, key, fallback) {
  const v = raw[key] === undefined ? fallback : raw[key];
  if (!isPositiveNumber(v)) throw new Error(`${key}: must be a number above 0, got ${JSON.stringify(v)}`);
  return v;
}

/** Validate a parsed config object (or undefined) and fill the defaults. Throws on a bad value. */
export function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const given = cfg.targets === undefined ? [] : cfg.targets;
  if (!Array.isArray(given)) throw new Error('targets: expected an array of {key, value, label, source}');
  const byKey = new Map();
  for (const row of given) {
    if (!row || typeof row.key !== 'string' || !row.key) throw new Error('targets: every row needs a key');
    if (byKey.has(row.key)) throw new Error(`targets: duplicate key ${row.key}`);
    byKey.set(row.key, row);
  }
  const targets = DEFAULT_TARGETS.map((base) => normalizeRow(byKey.get(base.key) ?? { key: base.key }, base));
  for (const [key, row] of byKey) if (!DEFAULT_TARGETS.some((d) => d.key === key)) targets.push(normalizeRow(row, null));
  return {
    version: 1,
    board: typeof cfg.board === 'string' && cfg.board ? cfg.board : 'continuous-claude',
    board_url: typeof cfg.board_url === 'string' && cfg.board_url ? cfg.board_url : null,
    stale_after_hours: positive(cfg, 'stale_after_hours', 36),
    projects_stale_after_hours: positive(cfg, 'projects_stale_after_hours', 168),
    band_history_start: typeof cfg.band_history_start === 'string' ? cfg.band_history_start : '2026-11-07',
    targets,
  };
}

/**
 * Read a config file. A missing file gives the defaults, unless `required` is set (the caller named the path
 * on the command line): then it throws. Bad JSON or a bad value throws, naming the file.
 */
export function loadConfig(file, { required = false } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT' && !required) return normalizeConfig({});
    throw new Error(`${file}: ${e.message}`);
  }
  try {
    return normalizeConfig(raw);
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}
