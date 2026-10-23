// backfill.mjs — seed the Report Runs registry from EXISTING history (Phase 4, T4.1).
//
// Reads the real historical artifacts already on disk (VP Weekly archives,
// FourthOS Sponsor decks, Self-Improvement proposal index, System Health reports)
// and UPSERTS one registry row per past run. These rows are REAL, PERMANENT
// history — they stay.
//
// IDEMPOTENT: every backfilled run gets a DETERMINISTIC runId of the form
//   `<type>|<period>|<stable-marker>`
// where the stable-marker is the archive folder / deck id / proposal file / health
// file stem — NOT a wall-clock timestamp. So re-running the backfill re-targets the
// SAME row (upsert = update in place) and NEVER creates duplicates. Prove it by
// running twice and diffing the DS row count.
//
// CLI:
//   node backfill.mjs            # write for real (upsert every discovered run)
//   node backfill.mjs --dry-run  # preview only — build + validate, no DS writes
//
// Each source is fault-isolated: a missing/parse-broken source logs a WARN and
// contributes 0 rows rather than aborting the whole backfill. A per-source count
// is printed at the end.
//
// ESM, no external deps. Reuses upsertReportRun (the registry spine) + the enums
// from config.mjs (single source of truth), so the contract can never drift.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { upsertReportRun, validateRun } from './upsert.mjs';
import { ROOT, SOURCE_BY_TYPE } from './config.mjs';

// Repo root = two levels up from scripts/report-registry.
export const REPO_ROOT = join(ROOT, '..', '..');

// --- source locations (overridable for tests) ----------------------------------
export const SOURCES = {
  vpArchiveDir: join(REPO_ROOT, 'ai-report-card', 'output', 'archive'),
  decksJson: '~/Projects/ai-enablement-decks/decks.json',
  selfImprovementIndex: join(REPO_ROOT, 'docs', 'self-improvement', 'INDEX.md'),
  healthChecksDir: join(REPO_ROOT, '.claude', 'cache', 'health-checks'),
};

// VP Weekly is published under this GH Pages site (archive-deploy model:
// reports/<week>/). Used to derive artifactUrl; falls back to the archive path.
const VP_PAGES_BASE = 'https://rev4nchist.github.io/ai-enablement-status/';

// --- normalization helpers (pure) ----------------------------------------------
// Period is stored verbatim for ISO weeks (2026-W27) and as YYYY-MM-DD for
// date-based periods (a timestamp is trimmed to its date).
export function normalizePeriod(raw) {
  const s = String(raw || '').trim();
  const week = /^(\d{4})-?W(\d{2})$/i.exec(s);
  if (week) return `${week[1]}-W${week[2]}`;
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (date) return date[1];
  return s;
}

// ISO-8601 week -> the Monday of that week, as a YYYY-MM-DD date. Notion's Run
// Date property needs a real date; an ISO-week string is not one.
export function isoWeekMonday(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

// System Health overall_status -> a registry Status enum value. Mirrors
// health_check.py's _overall_status() severities exactly: CRITICAL_FAIL and
// HIGH_FAIL are the two HIGH/CRITICAL fail severities that (bare) FAIL doesn't
// cover — a prior version of this map omitted them, so an unrecognized key fell
// through to the `|| 'OK'` default and silently recorded a CRITICAL/HIGH health
// failure as OK in the registry (found + corrected 2026-07-16).
const HEALTH_STATUS_MAP = {
  PASS: 'OK', OK: 'OK', WARN: 'Warn',
  FAIL: 'Failed', HIGH_FAIL: 'Failed', CRITICAL_FAIL: 'Failed', ERROR: 'Failed',
  SKIP: 'Skipped',
};
export function healthStatus(overall) {
  // Fail-safe default: an unrecognized overall_status should never silently
  // read as healthy. 'Warn' surfaces it for a human to check instead of hiding it.
  return HEALTH_STATUS_MAP[String(overall || '').toUpperCase()] || 'Warn';
}

// --- extractors (pure: content in, run objects out) ----------------------------

// VP Weekly: one run per archive week-dir (e.g. 2026-W27). runDate = Monday of the
// ISO week; artifactUrl = the GH Pages report URL; stable marker = the dir name.
// RETAINED after the 2026-07-25 retirement (the type stays in REPORT_TYPES, so this
// still produces valid rows) but deliberately UNWIRED from collectAllRuns below.
export function vpRunsFromDirs(dirNames) {
  const type = 'VP Weekly';
  const source = SOURCE_BY_TYPE[type];
  const runs = [];
  for (const dir of dirNames) {
    const m = /^(\d{4})-W(\d{2})$/i.exec(String(dir).trim());
    if (!m) continue;
    const period = normalizePeriod(dir);
    const runDate = isoWeekMonday(Number(m[1]), Number(m[2]));
    runs.push({
      runId: `${type}|${period}|${dir}`,
      type,
      period,
      runDate,
      status: 'OK',
      source,
      summary: `VP Weekly report ${period}`,
      artifactUrl: `${VP_PAGES_BASE}reports/${period}/`,
    });
  }
  return runs;
}

// FourthOS Sponsor: one run per deck in the sponsor-updates section. runDate =
// deck.date; artifactUrl = the deck deep link (href resolved against site.url);
// stable marker = deck.id.
export function sponsorRunsFromDecks(decks) {
  const type = 'FourthOS Sponsor';
  const source = SOURCE_BY_TYPE[type];
  const siteUrl = decks?.site?.url || '';
  const list = Array.isArray(decks?.decks) ? decks.decks : [];
  const runs = [];
  for (const deck of list) {
    if (deck.section !== 'sponsor-updates') continue;
    if (!deck.date) continue;
    const period = normalizePeriod(deck.date);
    const href = String(deck.href || '').replace(/^\.\//, '');
    const artifactUrl = href
      ? (siteUrl ? new URL(href, siteUrl).toString() : href)
      : undefined;
    const run = {
      runId: `${type}|${period}|${deck.id || period}`,
      type,
      period,
      runDate: period,
      status: 'OK',
      source,
      summary: deck.title || deck.description || `FourthOS Sponsor ${period}`,
    };
    if (artifactUrl) run.artifactUrl = artifactUrl;
    runs.push(run);
  }
  return runs;
}

// Self-Improvement: one run per markdown table row in INDEX.md. period = row date;
// summary = "<Component> — <Verdict>"; artifactUrl = the proposal md path; stable
// marker = the proposal file stem.
export function selfImprovementRunsFromIndex(md) {
  const type = 'Self-Improvement';
  const source = SOURCE_BY_TYPE[type];
  const runs = [];
  for (const line of String(md).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    const [date, component, verdict, , , proposal] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skips header + separator rows
    const pathMatch = /\(([^)]+\.md)\)/.exec(proposal);
    const relPath = pathMatch ? pathMatch[1] : '';
    const marker = relPath ? basename(relPath, '.md') : `${date}-${component}`;
    const period = normalizePeriod(date);
    const run = {
      runId: `${type}|${period}|${marker}`,
      type,
      period,
      runDate: period,
      status: 'OK',
      source,
      summary: `${component} — ${verdict}`,
    };
    if (relPath) run.artifactUrl = `docs/self-improvement/${relPath}`;
    runs.push(run);
  }
  return runs;
}

// System Health: one run per health_*.json report. period = the report date;
// status = mapped overall_status severity; summary = the PASS/WARN/FAIL/SKIP
// counts; artifactUrl = the sibling .md path; stable marker = the file stem.
export function healthRunFromReport(report, fileStem, mdRelPath) {
  const type = 'System Health';
  const source = SOURCE_BY_TYPE[type];
  const ts = report?.timestamp || '';
  const period = normalizePeriod(ts) || fileStem.replace(/^health_(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3');
  const runDate = ts && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts : period;
  const c = report?.counts || {};
  const summary = `PASS=${c.PASS ?? 0} WARN=${c.WARN ?? 0} FAIL=${c.FAIL ?? 0} SKIP=${c.SKIP ?? 0}`;
  const run = {
    runId: `${type}|${period}|${fileStem}`,
    type,
    period,
    runDate,
    status: healthStatus(report?.overall_status),
    source,
    summary,
  };
  if (mdRelPath) run.artifactUrl = mdRelPath;
  return run;
}

// --- source loaders (FS -> run arrays; fault-isolated) -------------------------
function safe(label, fn) {
  try {
    return fn();
  } catch (e) {
    console.error(`[backfill] WARN: source "${label}" failed: ${e.message} — contributing 0 rows`);
    return [];
  }
}


export function loadSponsorRuns(file = SOURCES.decksJson) {
  return safe('FourthOS Sponsor', () => {
    if (!existsSync(file)) return [];
    return sponsorRunsFromDecks(JSON.parse(readFileSync(file, 'utf8')));
  });
}

export function loadSelfImprovementRuns(file = SOURCES.selfImprovementIndex) {
  return safe('Self-Improvement', () => {
    if (!existsSync(file)) return [];
    return selfImprovementRunsFromIndex(readFileSync(file, 'utf8'));
  });
}

export function loadHealthRuns(dir = SOURCES.healthChecksDir) {
  return safe('System Health', () => {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => /^health_.*\.json$/i.test(f));
    const runs = [];
    for (const f of files) {
      try {
        const report = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const stem = basename(f, '.json');
        const mdRel = `.claude/cache/health-checks/${stem}.md`;
        runs.push(healthRunFromReport(report, stem, mdRel));
      } catch (e) {
        console.error(`[backfill] WARN: health file ${f} skipped: ${e.message}`);
      }
    }
    return runs;
  });
}

export function loadVpRuns(dir = SOURCES.vpArchiveDir) {
  return safe('VP Weekly', () => {
    if (!existsSync(dir)) return [];
    const dirs = readdirSync(dir).filter((d) => {
      try { return statSync(join(dir, d)).isDirectory(); } catch { return false; }
    });
    return vpRunsFromDirs(dirs);
  });
}

// Aggregate every source into a single labelled map of run arrays.
// VP Weekly is deliberately UNWIRED here — retired 2026-07-25 (see
// report-runs.ids.json retiredTypes). Re-seeding history for a report nobody runs
// adds churn without value; its already-backfilled rows stay in the registry
// untouched, and vpRunsFromDirs above is kept (still valid, still unit-tested) so
// reviving the type is a one-line change here.
export function collectAllRuns() {
  return {
    'FourthOS Sponsor': loadSponsorRuns(),
    'Self-Improvement': loadSelfImprovementRuns(),
    'System Health': loadHealthRuns(),
  };
}

// --- main ----------------------------------------------------------------------
export function runBackfill({ dryRun = false, upsert = upsertReportRun } = {}) {
  const bySource = collectAllRuns();
  const summary = {};
  let total = 0;
  for (const [label, runs] of Object.entries(bySource)) {
    let ok = 0;
    let failed = 0;
    for (const run of runs) {
      try {
        validateRun(run); // fail-loud on a malformed backfill row before any write
        if (!dryRun) upsert(run);
        ok += 1;
      } catch (e) {
        failed += 1;
        console.error(`[backfill] ERROR upserting ${run.runId}: ${e.message}`);
      }
    }
    summary[label] = { count: runs.length, upserted: ok, failed };
    total += ok;
    console.error(`[backfill] ${label}: ${runs.length} discovered, ${ok} ${dryRun ? 'valid (dry-run)' : 'upserted'}, ${failed} failed`);
  }
  console.error(`[backfill] TOTAL: ${total} rows ${dryRun ? 'previewed' : 'upserted'} (dryRun=${dryRun})`);
  return { summary, total, dryRun };
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const result = runBackfill({ dryRun });
  console.log(JSON.stringify(result.summary, null, 2));
  return result;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[backfill] FATAL: ${e.message}`);
    process.exit(1);
  });
}
