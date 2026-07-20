// check-drift.mjs — Report Runs freshness / drift detector (Phase 4, T4.2).
//
// READ-ONLY. For each report type, finds the newest registry row and its age, and
// flags any type whose newest row is older than a threshold (default 48h) — or has
// NO rows at all. This catches a scheduled report that silently stopped landing
// (the registry stops gaining rows) even when the pipeline itself reports success
// elsewhere. Intended to be invoked standalone or from the system health_check.
//
// CLI:
//   node check-drift.mjs                     # default 48h threshold
//   node check-drift.mjs --max-age-hours 72  # custom threshold
//
// Output: a JSON array of { type, newestRunDate, ageHours, drift } (one per known
// report type) plus a `drift: true|false` summary line on stderr. EXIT CODE is
// NONZERO if ANY type is in drift, so a scheduler/health-check can gate on it.
//
// Queries the Report Runs DS only — never writes. ESM, no external deps.
//
// RELATIONSHIP TO watchdog.mjs (consolidation groundwork, 2026-07-17): this
// detector and the silent-miss watchdog cover DIFFERENT, complementary classes and
// are BOTH kept. This file owns two classes the watchdog's presence check ignores —
// a STALE newest row (older than the threshold) and a MALFORMED/absent Run Date
// (unparseable) — but is period-BLIND and Status-BLIND (it never inspects Period or
// Status; only the newest Run Date's age). The watchdog owns the period-precise,
// schedule-aware "expected period has ZERO rows" class and WRITES a miss-row. As
// superset groundwork the watchdog now REUSES this file's `newestRunDate` +
// `computeDrift` core to additively REPORT (never write) the stale/malformed classes
// on its present-path, so a future consolidation can collapse to one superset
// detector. The exhaustive class-by-class behavior of both is pinned in
// test/detector-coverage-matrix.test.mjs.
import { pathToFileURL } from 'node:url';
import { queryDataSource, selectName, dateStart } from '../project-cards/lib/notion.mjs';
import { REPORT_RUNS_DS_ID, REPORT_TYPES } from './config.mjs';
// maxAgeForType lives in watchdog.mjs (it owns the SCHEDULE cadence map). This is a
// static import into the module that watchdog itself imports from — an ESM cycle that
// is SAFE because it is only ever CALLED at runtime (inside checkDrift/main), never at
// module-eval time, and watchdog likewise never reads a check-drift binding at eval.
import { maxAgeForType } from './watchdog.mjs';

export const DEFAULT_MAX_AGE_HOURS = 48;

// Newest (max) Run Date string across a set of rows, or '' if none.
// CHRONOLOGICAL, not lexicographic (T6.1 #5): different pipelines emit `-05:00` / `Z` /
// bare `YYYY-MM-DD` for the same type, so a raw string compare picks the wrong "newest".
// Compares by epoch ms (Date.parse); a parseable date always beats an unparseable one,
// and if ALL are unparseable the first non-empty string is kept (downstream computeDrift
// then treats it as drift). Never throws.
export function newestRunDate(rows) {
  let best = '';
  let bestMs = -Infinity;
  for (const r of rows || []) {
    const d = dateStart(r?.properties?.['Run Date']) || r?.last_edited_time || '';
    if (!d) continue;
    const ms = Date.parse(d);
    const cmp = Number.isNaN(ms) ? -Infinity : ms;
    if (best === '' || cmp > bestMs) { best = d; bestMs = cmp; }
  }
  return best;
}

// Group DS rows by their Report Type select value.
export function groupByType(rows) {
  const byType = {};
  for (const r of rows || []) {
    const t = selectName(r?.properties?.['Report Type']);
    if (!t) continue;
    (byType[t] ||= []).push(r);
  }
  return byType;
}

// --- pure drift core -----------------------------------------------------------
// newestByType: { [type]: newestRunDateString | '' }. Every type in `types` gets a
// row in the result; a type with no/unparseable date is drift=true, ageHours=null.
export function computeDrift(newestByType, { maxAgeHours = DEFAULT_MAX_AGE_HOURS, now = Date.now(), types = REPORT_TYPES } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  return types.map((type) => {
    const raw = newestByType[type] || '';
    const ms = raw ? Date.parse(raw) : NaN;
    if (!raw || Number.isNaN(ms)) {
      return { type, newestRunDate: raw || null, ageHours: null, drift: true };
    }
    const ageHours = Math.round(((nowMs - ms) / 3_600_000) * 100) / 100;
    return { type, newestRunDate: raw, ageHours, drift: ageHours > maxAgeHours };
  });
}

// --- CLI -----------------------------------------------------------------------
export function parseMaxAgeHours(argv) {
  const idx = argv.indexOf('--max-age-hours');
  if (idx !== -1 && argv[idx + 1] != null) return Number(argv[idx + 1]);
  const eq = argv.find((a) => a.startsWith('--max-age-hours='));
  if (eq) return Number(eq.slice('--max-age-hours='.length));
  return DEFAULT_MAX_AGE_HOURS;
}

// maxAgeHours: null (default) => per-cadence threshold per type via maxAgeForType
// (weekly widens to 192h so a healthy weekly is not false-flagged as drift); a number
// => a flat override applied to ALL types (the documented `--max-age-hours` behavior).
export function checkDrift({ maxAgeHours = null, query = queryDataSource, dsId = REPORT_RUNS_DS_ID, now = Date.now() } = {}) {
  const rows = query(dsId, {});
  const byType = groupByType(rows);
  return REPORT_TYPES.map((type) => {
    const newest = newestRunDate(byType[type] || []);
    const threshold = maxAgeHours ?? maxAgeForType(type);
    return computeDrift({ [type]: newest }, { maxAgeHours: threshold, now, types: [type] })[0];
  });
}

function main() {
  const argv = process.argv.slice(2);
  // Only a flat override when --max-age-hours is EXPLICITLY passed; otherwise null
  // -> per-cadence thresholds (daily 48h / weekly 192h) so a healthy weekly report
  // between runs is not counted as drift.
  const hasMaxAgeFlag = argv.includes('--max-age-hours') || argv.some((a) => a.startsWith('--max-age-hours='));
  const maxAgeHours = hasMaxAgeFlag ? parseMaxAgeHours(argv) : null;
  const report = checkDrift({ maxAgeHours });
  const drifting = report.filter((r) => r.drift);
  console.log(JSON.stringify(report, null, 2));
  const thresholdLabel = maxAgeHours == null ? 'per-cadence (daily 48h / weekly 192h)' : `${maxAgeHours}h`;
  console.error(`[check-drift] threshold=${thresholdLabel} — ${drifting.length}/${report.length} type(s) in drift${drifting.length ? ': ' + drifting.map((d) => d.type).join(', ') : ''}`);
  process.exit(drifting.length > 0 ? 1 : 0);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    console.error(`[check-drift] FATAL: ${e.message}`);
    process.exit(2);
  }
}
