// config.mjs — single source of truth for the Report Runs registry spine.
// Loads the canonical Notion IDs from report-runs.ids.json (built Phase 1) and
// re-exports them as named constants for the upsert + downstream wiring.
// ESM, no external deps. Path resolves relative to THIS module, so it is correct
// no matter which cwd the entry scripts are invoked from.
//
// Model = append-all-attempts. Idempotency key = `Run ID` (unique). A retry of
// the SAME run (identical runId) updates its row; a NEW run appends a new row.
// `Period` is a grouping field, NOT unique.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// report-registry ROOT (this dir).
export const ROOT = dirname(fileURLToPath(import.meta.url));

// Canonical IDs captured by Phase 1 (2026-07-05). Single source of truth.
export const IDS_PATH = join(ROOT, 'report-runs.ids.json');

const ids = JSON.parse(readFileSync(IDS_PATH, 'utf8'));

// --- Notion object ids ---
// Persist ALL THREE (mitigation #5): the container DB id (view repair needs it),
// the data source id (query/create target under the 2025-09-03 API), and the hub.
export const REPORT_RUNS_DB_ID = ids.reportRunsDatabaseId;
export const REPORT_RUNS_DS_ID = ids.reportRunsDataSourceId;
export const REPORTS_HUB_PAGE_ID = ids.reportsHubPageId;

// The 6 report child pages (one per report type) and the 7 linked views.
export const REPORT_CHILD_PAGES = ids.childPages;
export const REPORT_RUNS_VIEWS = ids.reportRunsViews;

// --- enumerations (validated by the upsert) ---
// REPORT_TYPES is the VALIDATION domain: every type the registry knows, INCLUDING
// retired ones. Retired types keep their historical rows in Notion, and those rows
// must stay valid/upsertable (a remap or re-read of history would otherwise fail),
// so they are deliberately NOT removed from this list.
export const REPORT_TYPES = ids.reportTypes;

// --- active vs retired (2026-07-25) ---------------------------------------------
// ACTIVE_REPORT_TYPES is the EXPECTATION domain: types a scheduled run is still
// expected to produce. Everything schedule-driven keys off this — the watchdog's
// schedule-parity check, the drift check, the hub launcher table, and the page
// refresh loop. Separating the two domains is what lets a report be retired without
// either (a) invalidating its history or (b) minting a Failed miss-row every week
// forever for a pipeline nobody runs.
export const RETIRED_REPORT_TYPES = ids.retiredTypes || [];
export const ACTIVE_REPORT_TYPES = REPORT_TYPES.filter(
  (t) => !RETIRED_REPORT_TYPES.includes(t),
);
export const STATUSES = ids.statuses;
// type -> originating scheduled job (Source select value). Callers that omit an
// explicit `source` in report-run.json can derive it from the report type.
export const SOURCE_BY_TYPE = ids.sourceByType;
// The KNOWN Source select values (dedup of SOURCE_BY_TYPE's values). The upsert +
// make-run validate `source` against this set so a typo can't mint a stray Notion
// select option (T6.1 #4). Single source of truth = SOURCE_BY_TYPE.
export const SOURCES = [...new Set(Object.values(SOURCE_BY_TYPE))];

// --- report-run.json contract keys (Phase 2a) ---
// runId = `<type>|<period>|<ISO-timestamp>`. Required vs optional split lives in
// upsert.mjs; this is the full key set the pipelines emit.
export const REPORT_RUN_KEYS = ids.reportRunContract.keys;

// --- registry conventions (proposal 08, 2026-07-17) -----------------------------
// Codifies, in ONE place, conventions that were previously only informally
// established by ad-hoc fixes. Single source of truth so make-run.mjs and
// watchdog.mjs can never independently drift on what a valid period/URL/
// corrective-row looks like.

// One period format per report-type cadence. VP Weekly's ISO-week period
// (`Get-Date -UFormat '%Y-W%V'`, e.g. "2026-W29") is the documented LONE
// exception — every other type emits a plain `YYYY-MM-DD` date period. This map is
// keyed off REPORT_TYPES (the validation domain), so it still covers VP Weekly after
// its 2026-07-25 retirement: its historical ISO-week rows must keep validating.
export const PERIOD_FORMAT_BY_TYPE = Object.fromEntries(
  REPORT_TYPES.map((t) => [t, t === 'VP Weekly' ? 'isoWeek' : 'date']),
);
export const ISO_WEEK_PERIOD_RE = /^\d{4}-W\d{2}$/;
export const ISO_DATE_PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

// Corrective rows (backfill/remap re-emits of an OLD period under TODAY's Run
// Date) must carry a `backfill:`/`remap:` summary prefix — refresh-pages.mjs's
// pickNewest() relies on exactly this prefix to exclude them from "Current run"
// (see the 2026-07-16 remap-proof fix). Anchored + case-insensitive.
export const CORRECTIVE_PREFIX_RE = /^(backfill|remap):/i;
// Single predicate over CORRECTIVE_PREFIX_RE (T9.2): both trust-metrics.mjs and
// check-drift.mjs need "is this row a corrective backfill/remap re-emit, not a
// genuine pipeline run" — extracted here so the two files can never independently
// drift on the definition (mirrors watchdog.mjs's isWatchdogMissRow being the
// single source of truth for its own prefix).
export function isCorrectiveSummary(summary) {
  return CORRECTIVE_PREFIX_RE.test(String(summary || '').trim());
}

// A Notion `url`-typed property (Artifact URL / Docx-Deck) rejects a non-URL
// value outright; a local filesystem path also stops resolving the moment the
// run's temp workspace is cleaned up. Artifact URLs must outlive promotion —
// only http(s) is accepted.
export const HTTP_URL_RE = /^https?:\/\//i;

// --- log-location hints (proposal 05, hub health strip) -------------------------
// A STATIC per-type string pointing at where a human would look for that
// pipeline's own wrapper log — not a live lookup (the wrappers' log dirs are
// documented in the CCv3 rules/README; verified against the wrapper scripts
// themselves, 2026-07-17). Cheap-by-design: no filesystem walk, no per-run file
// discovery. Update this map if a wrapper's log location ever moves.
export const LOG_HINT_BY_TYPE = {
  // Retired 2026-07-25; kept so a lookup for a historical VP Weekly row still resolves.
  'VP Weekly': 'ai-report-card/logs/scheduled-run.log (out-of-repo)',
  'FourthOS Sponsor': '~/.claude/logs/fourthos-weekly/',
  'System Health': '~/.claude/logs/health-check/',
  'Team Dashboard': '.claude/logs/dashboard-sync/',
  'Project Portfolio': '.claude/logs/project-cards/',
  'Self-Improvement': '.claude/logs/self-improvement/',
  // Same chain as System Health (weekend-plan.mjs runs inside scheduled-health-check.bat).
  'Weekend Plan': '~/.claude/logs/health-check/',
};

// --- ntn CLI (absolute winget exe — solves the ntn-PATH problem) ---
// Re-exported for callers that want the exe path without importing project-cards
// config. lib/notion.mjs already enforces the non-interactive contract around it.
// SINGLE SOURCE OF TRUTH (T8.1 #5): the literal path (and the NTN_EXE_PATH env
// override) live ONLY in scripts/project-cards/lib/config.mjs — re-exported here
// so both spines share one definition instead of two copy-pasted literals.
export { NTN_EXE } from '../project-cards/lib/config.mjs';
