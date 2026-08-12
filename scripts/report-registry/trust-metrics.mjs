// trust-metrics.mjs — the Report Runs registry measuring itself (proposal 09).
//
// The registry (report-run.json rows + the watchdog's synthesized miss-rows,
// proposal 08/05) now carries enough truth to answer "is our reporting reliable?"
// without a session-long manual audit. This module computes, over a lookback
// window (default 4 weeks):
//   - expected-vs-landed periods per week (per report type, summed) — how many
//     scheduled report runs SHOULD have landed by now this week, vs how many
//     genuinely did (excludes watchdog miss-rows and corrective backfill/remap
//     rows from "landed" — those are not a normal pipeline success).
//   - silentMissCount — count of watchdog-authored miss-rows in the window
//     (target: zero; each one is a run that never launched or was killed).
//   - meanTimeToDetectionHours — mean(watchdog miss-row's Run Date - the missed
//     deadline it detected), for miss-rows whose expected deadline is honestly
//     reconstructable (date-format periods only — VP Weekly's isoWeek period
//     can't be reversed to an exact calendar day without ambiguity, so those
//     samples are excluded rather than guessed; see expectedDeadlineForPeriod).
//   - correctiveRowRate — corrective (backfill:/remap:) rows as a fraction of
//     all rows in the window.
//
// PURE core (computeTrustMetrics + helpers) — no ntn spawn, fully unit-testable.
// The CLI's `main()` is the one place that reads live (queryDataSource + a
// best-effort human-section freshness check of the Reports hub page), following
// the same precedent as check-drift.mjs's `main()`.
//
// CLI:
//   node trust-metrics.mjs                 # human-readable summary (default 4 weeks)
//   node trust-metrics.mjs --json          # JSON summary
//   node trust-metrics.mjs --weeks 8       # custom lookback window
//
// Reuses watchdog.mjs (SCHEDULE, candidateForDay, isWatchdogMissRow, local-time
// day helpers) + config.mjs (CORRECTIVE_PREFIX_RE) + project-cards/lib/notion.mjs
// (queryDataSource, getPageBlocks, selectName/richText/dateStart). ESM, no
// external deps.
import { pathToFileURL } from 'node:url';
import {
  queryDataSource, getPageBlocks, selectName, richText, dateStart,
} from '../project-cards/lib/notion.mjs';
import {
  REPORT_RUNS_DS_ID, REPORTS_HUB_PAGE_ID, isCorrectiveSummary,
} from './config.mjs';
import {
  SCHEDULE, candidateForDay, isWatchdogMissRow,
  startOfDay, addDays, atTime, isoWeekLabel,
} from './watchdog.mjs';

export const DEFAULT_LOOKBACK_WEEKS = 4;

// --- row extraction (pure) -------------------------------------------------------
// Normalize a raw Report Runs DS row into the flat shape the metrics work on.
// Returns null when there is no `properties` object (defensive, mirrors
// refresh-pages.mjs's extractRun).
export function extractRunRow(row) {
  const p = row && row.properties;
  if (!p) return null;
  return {
    type: selectName(p['Report Type']) || '',
    period: richText(p.Period) || '',
    runDate: dateStart(p['Run Date']) || '',
    summary: richText(p.Summary) || '',
    status: selectName(p.Status) || '',
  };
}

// --- week buckets (pure) ----------------------------------------------------------
// Monday-anchored ISO week buckets [start, end) — `weeksCount` buckets ending with
// the CURRENT (possibly partial) week, oldest first.
export function mondayOfWeek(d) {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7; // Mon=0..Sun=6
  return addDays(s, -dow);
}

export function buildWeekBuckets(now, weeksCount = DEFAULT_LOOKBACK_WEEKS) {
  const thisMonday = mondayOfWeek(now);
  const buckets = [];
  for (let i = weeksCount - 1; i >= 0; i -= 1) {
    const start = addDays(thisMonday, -7 * i);
    const end = addDays(start, 7);
    buckets.push({ label: isoWeekLabel(start), start, end });
  }
  return buckets;
}

// --- expected periods within a week bucket (pure) ---------------------------------
// Every calendar day in [bucket.start, bucket.end) whose deadline (per
// watchdog.mjs's candidateForDay — the SAME mapping the real watchdog checks
// against) has already elapsed by `now` contributes ONE expected period for a
// daily-cadence entry; a weekly-cadence entry contributes at most one (its
// scheduled weekday, if that weekday's deadline has elapsed). Reuses
// candidateForDay so a week never diverges from what watchdog.mjs itself would
// have checked for the same instant.
export function expectedPeriodsInWeek(entry, bucket, now) {
  const periods = [];
  let day = bucket.start;
  while (day < bucket.end) {
    if (entry.cadence !== 'weekly' || day.getDay() === entry.weekday) {
      const { deadline, period } = candidateForDay(entry, day);
      if (deadline <= now) periods.push(period);
    }
    day = addDays(day, 1);
  }
  return periods;
}

function landedForPeriod(rows, type, period) {
  return rows.some((r) => r.type === type && r.period === period
    && !isWatchdogMissRow(r.summary) && !isCorrectiveSummary(r.summary));
}

// Expected-vs-landed, one row per week bucket, summed across ALL schedule
// entries (proposal 09's "expected-vs-landed rows per week"). `gap` is the
// silent-miss opportunity count for that week (expected minus landed) — it can
// be nonzero even with zero watchdog miss-rows if the watchdog itself hasn't
// run yet for that period.
export function computeWeeklyExpectedVsLanded({
  rows, now = new Date(), weeks = DEFAULT_LOOKBACK_WEEKS, schedule = SCHEDULE,
} = {}) {
  const buckets = buildWeekBuckets(now, weeks);
  return buckets.map((bucket) => {
    let expected = 0;
    let landed = 0;
    for (const entry of schedule) {
      const periods = expectedPeriodsInWeek(entry, bucket, now);
      expected += periods.length;
      for (const period of periods) {
        if (landedForPeriod(rows, entry.type, period)) landed += 1;
      }
    }
    return { week: bucket.label, expected, landed, gap: expected - landed };
  });
}

// --- mean time-to-detection (pure) -------------------------------------------------
// Reconstructs the expected deadline a watchdog miss-row detected, from its
// (type, period) pair — the INVERSE of candidateForDay: for a non-crossesMidnight
// entry the candidate day IS the period's calendar day; for a crossesMidnight
// entry the deadline lands the day AFTER the period (see watchdog.mjs's module
// doc — a crossesMidnight period's deadline is checked "the next morning").
// Returns null for a non-'date' periodFormat (VP Weekly's ISO-week period has no
// unambiguous single calendar day to reverse to) or an unparseable period — this
// is the "not honestly computable" case; callers must treat null as excluded, not
// zero.
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
export function expectedDeadlineForPeriod(entry, period) {
  if (!entry || entry.periodFormat !== 'date') return null;
  const periodDay = parseYmd(period);
  if (!periodDay) return null;
  const deadlineDay = entry.crossesMidnight ? addDays(periodDay, 1) : periodDay;
  return atTime(deadlineDay, entry.grace);
}

// samples in hours; a negative sample (clock skew / malformed data) is dropped
// rather than silently pulling the mean below zero.
export function computeTimeToDetection(missRows, { schedule = SCHEDULE } = {}) {
  const samples = [];
  for (const r of missRows) {
    const entry = schedule.find((e) => e.type === r.type);
    const deadline = entry ? expectedDeadlineForPeriod(entry, r.period) : null;
    if (!deadline) continue; // isoWeek or unparseable — honestly not computable
    const ms = Date.parse(r.runDate || '');
    if (Number.isNaN(ms)) continue;
    const hours = (ms - deadline.getTime()) / 3_600_000;
    if (hours >= 0) samples.push(hours);
  }
  if (!samples.length) return { meanHours: null, sampleCount: 0 };
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { meanHours: Math.round(mean * 100) / 100, sampleCount: samples.length };
}

// --- corrective-row rate (pure) ---------------------------------------------------
export function computeCorrectiveRate(rows) {
  if (!rows.length) return { rate: 0, correctiveCount: 0, totalCount: 0 };
  const correctiveCount = rows.filter((r) => isCorrectiveSummary(r.summary)).length;
  return {
    rate: Math.round((correctiveCount / rows.length) * 10000) / 10000,
    correctiveCount,
    totalCount: rows.length,
  };
}

function rowsInWindow(rows, start, end) {
  return rows.filter((r) => {
    const ms = Date.parse(r.runDate || '');
    return !Number.isNaN(ms) && ms >= start.getTime() && ms < end.getTime();
  });
}

// --- standing failures / consecutive non-OK (U2, T9.2) --------------------------
// The audit finding this closes: `landedForPeriod`'s "landed" coverage metric is
// Status-BLIND by design (it only asks "did a genuine row land", not "did it
// succeed") — that's a real and separate signal (coverage), kept unchanged above.
// But NOTHING in this module previously branched on Status at all, so a row that
// died mid-flight (e.g. the two real Self-Improvement rows stranded 2026-07-26/27)
// was scored as a landed success and never surfaced. This is the Status-aware
// counterpart: for each schedule type, walk its rows NEWEST-FIRST (by Run Date)
// and count how many consecutive rows from the top have Status !== 'OK', stopping
// at the first genuine 'OK'. A watchdog miss-row is Status='Failed' by construction
// (buildMissRun) and DELIBERATELY COUNTS here — unlike the coverage metric above,
// a watchdog miss-row IS a standing failure (a period nobody covered), and
// excluding it would silently re-create this task's own audit bug in a new metric.
// Rows with an unparseable/absent Run Date are excluded from the ordering (can't be
// placed in the newest-first sequence) rather than crashing the sort.
export function computeConsecutiveNonOk(rows, type) {
  const dated = rows
    .filter((r) => r.type === type)
    .map((r) => ({ r, ms: Date.parse(r.runDate || '') }))
    .filter((x) => !Number.isNaN(x.ms))
    .sort((a, b) => b.ms - a.ms); // newest first
  let count = 0;
  for (const { r } of dated) {
    // Corrective rows (backfill:/remap:) are human bookkeeping about a PAST
    // period, not evidence the pipeline ran — skip them entirely: a backfill:
    // OK must not zero the streak (it masked a real standing failure until
    // 2026-08-03), and a remap: Failed must not inflate it (13 same-timestamp
    // remap rows once inflated System Health's count).
    if (isCorrectiveSummary(r.summary)) continue;
    if (r.status === 'OK') break;
    count += 1;
  }
  return count;
}

// One entry per schedule type (order = schedule order). `rows` are the FULL
// normalized row set (not window-scoped) — a standing failure is a CURRENT-STATE
// signal ("how many runs in a row, right now, are non-OK"), not a per-window count,
// so it must see back past the lookback window to find the most recent genuine row.
export function computeStandingFailures(rows, { schedule = SCHEDULE } = {}) {
  return schedule.map((entry) => ({
    type: entry.type,
    consecutiveNonOk: computeConsecutiveNonOk(rows, entry.type),
  }));
}

// --- the rollup (pure core) --------------------------------------------------------
// `rawRows` are RAW Notion DS rows (extractRunRow applied internally) so callers
// can hand this the direct output of queryDataSource(dsId, {}) with no
// transformation of their own — matches watchdog.mjs/check-drift.mjs's convention
// of taking raw rows at the boundary and normalizing inside.
export function computeTrustMetrics({
  rawRows = [], now = new Date(), weeks = DEFAULT_LOOKBACK_WEEKS, schedule = SCHEDULE,
} = {}) {
  const rows = rawRows.map(extractRunRow).filter(Boolean);
  const buckets = buildWeekBuckets(now, weeks);
  const windowStart = buckets[0].start;
  const windowEnd = buckets[buckets.length - 1].end;
  const windowRows = rowsInWindow(rows, windowStart, windowEnd);

  const weeklyExpectedVsLanded = computeWeeklyExpectedVsLanded({
    rows, now, weeks, schedule,
  });
  const silentMissRows = windowRows.filter((r) => isWatchdogMissRow(r.summary));
  const ttd = computeTimeToDetection(silentMissRows, { schedule });
  const corrective = computeCorrectiveRate(windowRows);
  const standingFailures = computeStandingFailures(rows, { schedule });

  return {
    lookbackWeeks: weeks,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    weeks: weeklyExpectedVsLanded,
    silentMissCount: silentMissRows.length,
    meanTimeToDetectionHours: ttd.meanHours,
    ttdSampleCount: ttd.sampleCount,
    correctiveRowRate: corrective.rate,
    correctiveRowCount: corrective.correctiveCount,
    totalRowsInWindow: corrective.totalCount,
    standingFailures,
  };
}

// --- Notion block renderer (pure; appended to the hub health-strip section) --------
function seg(content, { link, bold, italic } = {}) {
  const o = { type: 'text', text: { content: String(content ?? '').slice(0, 2000) } };
  if (typeof link === 'string' && /^https?:\/\//i.test(link)) o.text.link = { url: link };
  if (bold || italic) {
    o.annotations = {};
    if (bold) o.annotations.bold = true;
    if (italic) o.annotations.italic = true;
  }
  return o;
}

// Returns [] when `summary` is null/undefined — the hub table renders with no
// trailing rollup if a trust-metrics computation wasn't available (non-fatal
// caller pattern; see refresh-pages.mjs's CLI wiring).
export function renderTrustRollupBlocks(summary) {
  if (!summary) return [];
  const header = {
    type: 'paragraph',
    paragraph: { rich_text: [seg(`Trust metrics (last ${summary.lookbackWeeks} weeks)`, { bold: true })] },
  };
  const weekLines = summary.weeks
    .map((w) => `${w.week}: expected ${w.expected} / landed ${w.landed}${w.gap > 0 ? ` (gap ${w.gap})` : ''}`)
    .join('  ·  ');
  const weekPara = {
    type: 'paragraph',
    paragraph: { rich_text: [seg(weekLines || 'no scheduled periods in window')] },
  };
  const ttdText = summary.meanTimeToDetectionHours == null
    ? 'n/a'
    : `${summary.meanTimeToDetectionHours}h (n=${summary.ttdSampleCount})`;
  const correctivePct = Math.round(summary.correctiveRowRate * 100);
  const statsPara = {
    type: 'paragraph',
    paragraph: {
      rich_text: [
        seg('Silent misses: ', { bold: true }), seg(`${summary.silentMissCount} (target: 0)`),
        seg('   Mean time-to-detection: ', { bold: true }), seg(ttdText),
        seg('   Corrective-row rate: ', { bold: true }),
        seg(`${correctivePct}% (${summary.correctiveRowCount}/${summary.totalRowsInWindow})`),
      ],
    },
  };
  return [header, weekPara, statsPara];
}

// --- freshness checker for HUMAN-authored hub sections (proposal 05, item 3) -------
// Cheap form: scans the hub page's top-level blocks for heading sections NOT in
// `machineHeadings` (the machine-owned sections this system writes), and looks
// for a "Reviewed: YYYY-MM-DD" stamp anywhere in that section's body text. A
// section with no stamp is flagged `unstamped: true` (a WARN, not an error — the
// stamp convention is opt-in until a human adopts it; see README). A stamped
// section older than `maxAgeDays` is flagged `stale: true`. This NEVER edits a
// human section — it only reads and reports.
export const REVIEWED_DATE_RE = /Reviewed:\s*(\d{4}-\d{2}-\d{2})/i;
export const HUMAN_SECTION_MAX_AGE_DAYS = 30;

function blockPlainText(b) {
  const rich = b?.[b.type]?.rich_text;
  if (!Array.isArray(rich)) return '';
  return rich.map((t) => t.plain_text ?? t.text?.content ?? '').join('');
}

// Split a flat block array into heading-anchored sections; a leading run of
// blocks before the FIRST heading is dropped (no heading to attribute it to —
// mirrors the assumption findSectionBlocks/replaceSectionBlocks already make
// about the hub being heading-organized). Excludes sections whose heading text
// is in `machineHeadings`.
export function scanHumanSections(blocks, { machineHeadings = [] } = {}) {
  const headingTypes = new Set(['heading_1', 'heading_2', 'heading_3']);
  const sections = [];
  let current = null;
  for (const b of blocks || []) {
    if (headingTypes.has(b?.type)) {
      current = { heading: blockPlainText(b).trim(), blocks: [] };
      sections.push(current);
    } else if (current) {
      current.blocks.push(b);
    }
  }
  return sections.filter((s) => !machineHeadings.includes(s.heading));
}

export function assessSectionFreshness(section, { now = new Date(), maxAgeDays = HUMAN_SECTION_MAX_AGE_DAYS } = {}) {
  for (const b of section.blocks) {
    const m = REVIEWED_DATE_RE.exec(blockPlainText(b));
    if (m) {
      const reviewed = new Date(m[1]);
      const ageDays = Math.round((now.getTime() - reviewed.getTime()) / 86_400_000);
      return {
        heading: section.heading, reviewedDate: m[1], ageDays, stale: ageDays > maxAgeDays, unstamped: false,
      };
    }
  }
  return {
    heading: section.heading, reviewedDate: null, ageDays: null, stale: null, unstamped: true,
  };
}

export function checkHumanSectionFreshness(blocks, opts = {}) {
  return scanHumanSections(blocks, opts).map((s) => assessSectionFreshness(s, opts));
}

// --- CLI -----------------------------------------------------------------------
function parseWeeks(argv) {
  const idx = argv.indexOf('--weeks');
  if (idx !== -1 && argv[idx + 1] != null) return Number(argv[idx + 1]);
  const eq = argv.find((a) => a.startsWith('--weeks='));
  if (eq) return Number(eq.slice('--weeks='.length));
  return DEFAULT_LOOKBACK_WEEKS;
}

// The hub's own machine-owned heading text (duplicated literal, not imported —
// importing refresh-pages.mjs here would create a module cycle since
// refresh-pages.mjs imports computeTrustMetrics/renderTrustRollupBlocks from
// THIS file). Keep in sync with refresh-pages.mjs's HUB_LAUNCHER_HEADING text
// if that section's heading ever changes.
const HUB_MACHINE_HEADINGS = ['🗂 Report pages'];

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const weeks = parseWeeks(argv);
  if (!Number.isFinite(weeks) || weeks <= 0) {
    throw new Error('--weeks requires a positive number');
  }

  const rawRows = queryDataSource(REPORT_RUNS_DS_ID, {});
  const summary = computeTrustMetrics({ rawRows, weeks });

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[trust-metrics] window ${summary.windowStart} .. ${summary.windowEnd} (${summary.lookbackWeeks} week(s))`);
    for (const w of summary.weeks) {
      console.log(`  ${w.week}: expected=${w.expected} landed=${w.landed} gap=${w.gap}`);
    }
    console.log(`  silentMissCount=${summary.silentMissCount} (target 0)`);
    console.log(`  meanTimeToDetectionHours=${summary.meanTimeToDetectionHours ?? 'n/a'} (n=${summary.ttdSampleCount})`);
    console.log(`  correctiveRowRate=${summary.correctiveRowRate} (${summary.correctiveRowCount}/${summary.totalRowsInWindow})`);
    console.log('  standing failures (consecutive non-OK rows, most-recent-first, per type):');
    for (const s of summary.standingFailures) {
      console.log(`    ${s.type}: ${s.consecutiveNonOk}`);
    }
  }

  // Best-effort, non-fatal: freshness of the hub's human-authored sections.
  try {
    const blocks = getPageBlocks(REPORTS_HUB_PAGE_ID);
    const freshness = checkHumanSectionFreshness(blocks, { machineHeadings: HUB_MACHINE_HEADINGS });
    if (freshness.length) {
      console.error('[trust-metrics] hub human-section freshness:');
      for (const f of freshness) {
        if (f.unstamped) {
          console.error(`  "${f.heading}": no reviewed-date stamp (add "Reviewed: YYYY-MM-DD" to adopt the convention)`);
        } else if (f.stale) {
          console.error(`  "${f.heading}": STALE — reviewed ${f.reviewedDate} (${f.ageDays}d ago, > ${HUMAN_SECTION_MAX_AGE_DAYS}d)`);
        } else {
          console.error(`  "${f.heading}": fresh — reviewed ${f.reviewedDate} (${f.ageDays}d ago)`);
        }
      }
    }
  } catch (e) {
    console.error(`[trust-metrics] WARN: hub human-section freshness check skipped (non-fatal): ${e.message}`);
  }

  process.exit(0);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    console.error(`[trust-metrics] FATAL: ${e.message}`);
    process.exit(2);
  }
}
