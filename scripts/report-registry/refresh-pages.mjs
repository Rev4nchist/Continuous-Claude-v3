// refresh-pages.mjs — Report Runs Phase 3: deterministic (ntn-only, NO MCP) refresh
// of the 6 report child pages + the Reports hub launcher, from the newest registry
// row per report type. READ-then-splice; NEVER a full-page edit.
//
// What it does (all via lib/notion.mjs's block-level section splice — never touches
// MCP-only blocks, linked views, or human-owned sections):
//   1. Per child page (all 6 in REPORT_CHILD_PAGES): query the Report Runs DS for
//      that Report Type, newest first; render a "Current run" callout from the newest
//      row (or "No runs recorded yet." when the type has 0 rows) and splice it into
//      that page's `## Current run` section. The `## History` linked-view block is
//      left untouched (findSectionBlocks scopes the splice to the Current-run body).
//   2. Hub launcher: an ADDITIVE, machine-owned `## 🗂 Report pages` section on the
//      Reports hub — a table (one row per type → child-page link + latest Status +
//      Run Date + http Artifact link) plus a trailing link to the "All Report Runs
//      — by Type" overview view. Created near the TOP if absent; on re-run only its
//      BODY is replaced (idempotent). The human `## 📥 Latest reports` narrative and
//      every other hub section are NEVER touched.
//
// SAFETY: writes exactly two kinds of section — `## Current run` (child pages, which
// this system owns) and `## 🗂 Report pages` (hub, machine-owned). Link rich_text is
// only emitted for real http(s) URLs (a Notion link with a relative path 400s the
// whole request), so a non-URL Artifact value (a deploy-fail fallback path) degrades
// to a plain "—" cell / no callout link rather than dropping the write.
//
// NON-FATAL: each child page and the hub are independently try/caught — one failing
// page logs `[refresh-pages] ERROR …` and the sweep continues. The CLI exits 0 on
// success/partial (observability must never fail the parent sweep); a top-level
// config/spawn fatal exits 2.
//
// CLI:
//   node refresh-pages.mjs                 # refresh all 6 child pages + the hub launcher
//   node refresh-pages.mjs --dry-run       # print the planned callouts + launcher table; write nothing
//   node refresh-pages.mjs --type "<Report Type>"  # SCOPED: write only that type's
//     child page, then the hub launcher. The hub table still renders every type's
//     latest row (its body is replaced whole), so all 6 types are still QUERIED —
//     scoping saves the 5 unneeded child-page WRITES, not the reads. Used by
//     upsert.mjs's post-write refresh so the hub can never lag a registry write.
//
// Reuses scripts/project-cards/lib/notion.mjs (absolute-NTN_EXE non-interactive
// contract). ESM, no external deps.
import { pathToFileURL } from 'node:url';
import {
  queryDataSource, getPageBlocks, findSectionBlocks, replaceSectionBlocks,
  insertBlocksAfter, selectName, dateStart, richText, urlVal, title,
} from '../project-cards/lib/notion.mjs';
import {
  acquirePageLockWaiting, releasePageLock,
  HUB_LOCK_PATH, HUB_LOCK_STALE_MS, HUB_LOCK_WAIT_MS, HUB_LOCK_POLL_MS,
} from '../project-cards/lib/page-lock.mjs';
import {
  REPORT_RUNS_DS_ID, REPORT_CHILD_PAGES, REPORTS_HUB_PAGE_ID,
  REPORT_TYPES, REPORT_RUNS_VIEWS, LOG_HINT_BY_TYPE,
} from './config.mjs';
import {
  SCHEDULE, nextExpectedDeadline, isWatchdogMissRow, ymd,
  candidateForDay, startOfDay, addDays,
} from './watchdog.mjs';
import { computeTrustMetrics, renderTrustRollupBlocks } from './trust-metrics.mjs';

// The two section headings this refresh owns/writes.
export const CURRENT_RUN_HEADING = '## Current run';
export const HUB_LAUNCHER_HEADING = '## 🗂 Report pages';
// The heading text stored in the created hub heading_2 block (no Markdown '## ').
const HUB_LAUNCHER_TEXT = HUB_LAUNCHER_HEADING.replace(/^#+\s*/, '').trim();

// The hub overview linked view ("All Report Runs — by Type"), a block on the hub.
export const OVERVIEW_VIEW_ID = REPORT_RUNS_VIEWS['All Report Runs — by Type (hub)'];

// A Notion rich_text link REQUIRES a real URL — a bare filesystem path (a deploy-fail
// Artifact fallback) would 400 the whole PATCH. Only ever attach a link for http(s).
const HTTP_URL_RE = /^https?:\/\//i;
const isHttpUrl = (v) => typeof v === 'string' && HTTP_URL_RE.test(v);

// --- url builders (pure) -------------------------------------------------------

// Canonical Notion page URL from an id (dashes stripped).
export function notionPageUrl(id) {
  return `https://www.notion.so/${String(id).replace(/-/g, '')}`;
}

// Deep-link to a view/block that lives ON a page: `<page>#<block>` (both dash-stripped).
// Used for the "All Report Runs — by Type" overview view embedded on the hub.
export function notionViewUrl(pageId, viewId) {
  return `${notionPageUrl(pageId)}#${String(viewId).replace(/-/g, '')}`;
}

// --- rich-text segment (pure) --------------------------------------------------
// One Notion rich_text object. Truncates content to Notion's 2000-char cap. A link
// is attached ONLY when the value is a real http(s) URL (guarded here too, defense
// in depth). Bold/italic annotations added on request.
function seg(content, { link, bold, italic } = {}) {
  const o = { type: 'text', text: { content: String(content ?? '').slice(0, 2000) } };
  if (isHttpUrl(link)) o.text.link = { url: link };
  if (bold || italic) {
    o.annotations = {};
    if (bold) o.annotations.bold = true;
    if (italic) o.annotations.italic = true;
  }
  return o;
}

// A table cell is an ARRAY of rich_text segments.
const cell = (...segs) => segs;

// --- row extraction (pure) -----------------------------------------------------

// Normalize a raw Notion Report-Runs row into the fields the renderers use.
// Returns null when there is no row (a type with 0 registry rows) or no properties.
export function extractRun(row) {
  const p = row && row.properties;
  if (!p) return null;
  return {
    runDate: dateStart(p['Run Date']) || '',
    status: selectName(p.Status) || '',
    summary: richText(p.Summary) || '',
    artifactUrl: urlVal(p['Artifact URL']) || '',
    title: title(p['Report Run']) || '',
  };
}

// Chronologically newest row (defensive over the DS `Run Date descending` sort:
// mixed-tz strings from different pipelines can defeat a lexicographic pick — this
// compares by epoch ms). Returns null on an empty set; never throws.
//
// Corrective-row guard (2026-07-16): backfill/remap rows carry an OLD period but
// TODAY'S Run Date, so a naive newest-by-date pick would present a correction of
// ancient history as the "Current run". Rows whose Summary starts with
// "backfill"/"remap" (the corrective-row convention) are excluded from the pick
// unless a type has ONLY corrective rows.
function summaryText(r) {
  const rt = r?.properties?.Summary?.rich_text;
  return (Array.isArray(rt) ? rt.map((t) => t?.plain_text || '').join('') : '').trim();
}
function isCorrectiveRow(r) {
  const s = summaryText(r).toLowerCase();
  return s.startsWith('backfill') || s.startsWith('remap');
}
// A synthetic row is a corrective (backfill/remap) OR a watchdog miss-row. Both carry
// TODAY'S Run Date but do NOT represent a genuine pipeline success, so they must never
// win "Current run"/Status/Watchdog over a real row for the same period (WS1b): once a
// genuine Self-Improvement row lands again, a same-period `watchdog:` Failed miss-row
// could otherwise win by date and show "missing" for a day that actually succeeded.
function isSyntheticRow(r) {
  return isCorrectiveRow(r) || isWatchdogMissRow(summaryText(r));
}
export function pickNewest(rows) {
  const all = rows || [];
  const genuine = all.filter((r) => !isSyntheticRow(r));
  const pool = genuine.length > 0 ? genuine : all;
  let best = null;
  let bestMs = -Infinity;
  for (const r of pool) {
    const d = dateStart(r?.properties?.['Run Date']) || r?.last_edited_time || '';
    const ms = Date.parse(d);
    const cmp = Number.isNaN(ms) ? -Infinity : ms;
    if (best === null || cmp > bestMs) { best = r; bestMs = cmp; }
  }
  return best;
}

// --- Current-run callout builder (pure) ----------------------------------------
// Returns the block array to splice into a child page's `## Current run` section.
// `row` is the newest raw Notion row, or null/undefined for a type with no runs.
//   populated -> [ callout: **Latest:** <runDate> · **<status>** · <summary> (· link) ]
//   empty     -> [ callout: _No runs recorded yet._ ]
export function buildCurrentRunBlocks(row) {
  const run = extractRun(row);
  if (!run) {
    return [{
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '📭' },
        rich_text: [seg('No runs recorded yet.', { italic: true })],
      },
    }];
  }
  const rich = [seg('Latest: ', { bold: true }), seg(run.runDate || 'unknown')];
  if (run.status) { rich.push(seg(' · '), seg(run.status, { bold: true })); }
  if (run.summary) { rich.push(seg(' · '), seg(run.summary)); }
  if (isHttpUrl(run.artifactUrl)) { rich.push(seg(' · '), seg('View artifact', { link: run.artifactUrl })); }
  return [{
    type: 'callout',
    callout: { icon: { type: 'emoji', emoji: '📌' }, rich_text: rich },
  }];
}

// --- health-strip columns (proposal 05) -----------------------------------------
// "Next expected" — the upcoming deadline+period for a type, from watchdog.mjs's
// SCHEDULE (the SAME schedule the real silent-miss watchdog checks against). A
// type absent from SCHEDULE (should never happen — proposal 08's watchdog-parity
// convention enforces coverage) degrades to a dash rather than throwing, since
// this renders on every hub refresh and must never abort the write.
export function nextExpectedLabel(type, { schedule = SCHEDULE, now = new Date() } = {}) {
  const entry = schedule.find((e) => e.type === type);
  if (!entry) return '—';
  try {
    const { deadline, period } = nextExpectedDeadline(entry, now);
    return `${period} (by ${ymd(deadline)})`;
  } catch {
    return '—';
  }
}

// The run's LOCAL calendar day as 'YYYY-MM-DD'. A bare date is ALREADY a local
// calendar day (returned as-is — Date.parse would misread a bare 'YYYY-MM-DD' as UTC
// midnight and shift it to the prior evening in a negative-offset zone); an ISO
// instant is converted to its local day via ymd(). null when unparseable.
function runLocalDay(runDate) {
  const s = String(runDate ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ymd(new Date(ms));
}

// The most-recent expected period whose deadline+grace has ALREADY passed as of
// `now`, or null if none has (e.g. a brand-new schedule with nothing due yet).
// Reuses candidateForDay so the candidate-day/deadline mapping is IDENTICAL to the
// real silent-miss watchdog's — no magic thresholds. Bounded walk-back: a weekly
// cadence repeats within 7 days, a daily within 2, so ≤8 days always finds it.
function mostRecentPassedPeriod(entry, now) {
  let day = startOfDay(now);
  const maxBack = entry.cadence === 'weekly' ? 8 : 2;
  for (let i = 0; i <= maxBack; i += 1) {
    if (entry.cadence === 'weekly' && day.getDay() !== entry.weekday) {
      day = addDays(day, -1);
      continue;
    }
    const { candidateDay, deadline, period } = candidateForDay(entry, day);
    if (deadline.getTime() <= now.getTime()) return { candidateDay, deadline, period };
    day = addDays(day, -1);
  }
  return null;
}

// "Watchdog" verdict — PERIOD-PRECISE (reuses watchdog.mjs's own SCHEDULE +
// candidateForDay cadence logic; no maxAge threshold, so a healthy WEEKLY report
// between runs never reads "stale"):
//   'missing'     — the newest known row for this type IS a watchdog miss-row
//                    (a genuine silent miss the watchdog already caught).
//   'stale'       — a real row exists but its Run Date predates the most-recent
//                    expected period whose deadline+grace has passed (a genuinely
//                    missed run — flagged right after its own weekday+grace, so a
//                    dead weekly cannot masquerade as healthy for a week).
//   'present'     — a real row covering the most-recent expected period (or newer),
//                    or nothing is due yet.
//   'no runs'     — the type has zero registry rows at all.
//   'unscheduled' — the type has no watchdog SCHEDULE entry (parity violation).
export function watchdogVerdict(type, run, { schedule = SCHEDULE, now = new Date() } = {}) {
  const entry = schedule.find((e) => e.type === type);
  if (!entry) return 'unscheduled';
  if (!run) return 'no runs';
  if (isWatchdogMissRow(run.summary)) return 'missing';
  const expected = mostRecentPassedPeriod(entry, now);
  if (!expected) return 'present'; // nothing due yet — an existing run is fine
  const runDay = runLocalDay(run.runDate);
  if (runDay == null) return 'stale'; // unparseable Run Date — cannot prove freshness
  // Compare LOCAL calendar days as strings (both 'YYYY-MM-DD' -> lexical == chrono).
  // NEVER string-compare periods across types (VP Weekly's period is ISO-week); this
  // compares the run's day to the expected candidate DAY, which is date-shaped for all.
  return runDay >= ymd(expected.candidateDay) ? 'present' : 'stale';
}

// --- Hub launcher builder (pure) -----------------------------------------------
// Returns the BODY blocks for the `## 🗂 Report pages` hub section: a 7-column
// table (Report | Status | Run date | Artifact | Next expected | Log | Watchdog),
// one row per report type linking to its child page, a trailing paragraph linking
// the overview view, and (when `trustSummary` is supplied) the trust-metrics
// weekly rollup appended to this SAME section — one machine-owned surface,
// idempotent under the existing section-splice (proposals 05 + 09).
// `latestByType` maps a type -> its normalized run (from extractRun) or null.
export function buildHubLauncherBlocks({
  latestByType = {},
  childPages = REPORT_CHILD_PAGES,
  hubId = REPORTS_HUB_PAGE_ID,
  overviewViewId = OVERVIEW_VIEW_ID,
  types = REPORT_TYPES,
  schedule = SCHEDULE,
  now = new Date(),
  trustSummary = null,
} = {}) {
  const header = {
    type: 'table_row',
    table_row: {
      cells: [
        cell(seg('Report', { bold: true })),
        cell(seg('Status', { bold: true })),
        cell(seg('Run date', { bold: true })),
        cell(seg('Artifact', { bold: true })),
        cell(seg('Next expected', { bold: true })),
        cell(seg('Log', { bold: true })),
        cell(seg('Watchdog', { bold: true })),
      ],
    },
  };
  const rows = types.map((type) => {
    const run = latestByType[type] || null;
    const nameCell = cell(seg(type, { link: notionPageUrl(childPages[type]) }));
    const statusCell = cell(seg(run?.status || '—'));
    const dateCell = cell(seg(run?.runDate || '—'));
    // Never blank (WS2): a live http artifact -> "link"; otherwise deep-link the
    // report's Notion child page ("page") so the Artifact cell is always a working
    // quick-link. Degrades to a dash only if the type has no child page at all.
    let artCell;
    if (isHttpUrl(run?.artifactUrl)) {
      artCell = cell(seg('link', { link: run.artifactUrl }));
    } else if (childPages[type]) {
      artCell = cell(seg('page', { link: notionPageUrl(childPages[type]) }));
    } else {
      artCell = cell(seg('—'));
    }
    const nextCell = cell(seg(nextExpectedLabel(type, { schedule, now })));
    const logCell = cell(seg(LOG_HINT_BY_TYPE[type] || '—'));
    const watchdogCell = cell(seg(watchdogVerdict(type, run, { schedule, now })));
    return {
      type: 'table_row',
      table_row: { cells: [nameCell, statusCell, dateCell, artCell, nextCell, logCell, watchdogCell] },
    };
  });
  const table = {
    type: 'table',
    table: {
      table_width: 7,
      has_column_header: true,
      has_row_header: false,
      children: [header, ...rows],
    },
  };
  const overview = {
    type: 'paragraph',
    paragraph: {
      rich_text: [
        seg('All runs (by type): '),
        seg('All Report Runs — by Type', { link: notionViewUrl(hubId, overviewViewId) }),
      ],
    },
  };
  return [table, overview, ...renderTrustRollupBlocks(trustSummary)];
}

// --- dry-run rendering (pure) --------------------------------------------------
// Flatten a rich_text array to plain text (link urls surfaced in <>).
function flatRich(rich) {
  return (rich || []).map((s) => {
    const t = s.text?.content ?? '';
    return s.text?.link ? `${t} <${s.text.link.url}>` : t;
  }).join('');
}

// Human-readable one-liner(s) for a block array, for --dry-run output.
export function describeBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === 'callout') out.push(`  callout: ${flatRich(b.callout.rich_text)}`);
    else if (b.type === 'paragraph') out.push(`  paragraph: ${flatRich(b.paragraph.rich_text)}`);
    else if (b.type === 'heading_2') out.push(`  heading_2: ${flatRich(b.heading_2.rich_text)}`);
    else if (b.type === 'table') {
      out.push(`  table (${b.table.table_width} cols, ${b.table.children.length} rows):`);
      for (const r of b.table.children) {
        out.push(`    | ${r.table_row.cells.map((c) => flatRich(c)).join(' | ')} |`);
      }
    } else out.push(`  ${b.type}`);
  }
  return out.join('\n');
}

// --- per-type read (transport-injectable) --------------------------------------
// Query the DS for one Report Type, newest first. Returns { rows, newest }.
export function fetchLatest(type, { dsId = REPORT_RUNS_DS_ID, query = queryDataSource } = {}) {
  const rows = query(dsId, {
    filter: { property: 'Report Type', select: { equals: type } },
    sorts: [{ property: 'Run Date', direction: 'descending' }],
  });
  return { rows, newest: pickNewest(rows) };
}

// --- child page refresh (transport-injectable) ---------------------------------
// Query + build + splice one child page's `## Current run` section. dryRun prints and
// writes nothing. Returns { type, pageId, rows, wrote, newest }.
export function refreshChildPage(type, pageId, {
  dryRun = false, dsId = REPORT_RUNS_DS_ID,
  query = queryDataSource, replaceSection = replaceSectionBlocks,
} = {}) {
  const { rows, newest } = fetchLatest(type, { dsId, query });
  const blocks = buildCurrentRunBlocks(newest);
  if (dryRun) {
    console.log(`\n[dry-run] ${type} (${pageId}) — ${rows.length} row(s) -> "${CURRENT_RUN_HEADING}":`);
    console.log(describeBlocks(blocks));
    return { type, pageId, rows: rows.length, wrote: false, newest: extractRun(newest) };
  }
  replaceSection(pageId, CURRENT_RUN_HEADING, blocks);
  console.error(`[refresh-pages] ${type}: wrote "${CURRENT_RUN_HEADING}" (${rows.length} row(s))`);
  return { type, pageId, rows: rows.length, wrote: true, newest: extractRun(newest) };
}

// --- hub launcher refresh (transport-injectable) -------------------------------
// Default hub-lock acquire/release: the shared .hub.lock, bounded WAIT-then-proceed
// (poll a live holder up to 60s, then proceed with a warn). Injectable so a test can
// verify acquire/release without touching a real lock file. See lib/page-lock.mjs.
const defaultAcquireHubLock = () => acquirePageLockWaiting(HUB_LOCK_PATH, {
  staleMs: HUB_LOCK_STALE_MS, waitMs: HUB_LOCK_WAIT_MS, pollMs: HUB_LOCK_POLL_MS,
});
const defaultReleaseHubLock = () => releasePageLock(HUB_LOCK_PATH);

// Maintain the ADDITIVE `## 🗂 Report pages` section. If it exists, replace ONLY its
// body (idempotent). If absent, CREATE it near the top: insert `[heading, ...body]`
// after the block immediately preceding the page's first heading (so it splits no
// existing section); if the page opens with a heading, append at the end instead.
// Returns { wrote, action }.
//
// The Reporting Hub is written by three independent writers (premortem mitigation
// #6, W4 race): this launcher refresh, the project-cards sweep (cockpit + gallery),
// and dashboard-sync. The hub-page WRITE is serialized on the shared .hub.lock —
// bounded WAIT-then-proceed: on a live holder we wait up to 60s then PROCEED with a
// loud warn (availability > strictness; the lock only reduces overlap and must never
// deadlock the pipeline). --dry-run takes no lock (it writes nothing).
export function refreshHub({
  latestByType = {}, dryRun = false, hubId = REPORTS_HUB_PAGE_ID,
  childPages = REPORT_CHILD_PAGES, overviewViewId = OVERVIEW_VIEW_ID, types = REPORT_TYPES,
  now = new Date(), trustSummary = null,
  getBlocks = getPageBlocks, findSection = findSectionBlocks,
  replaceSection = replaceSectionBlocks, insertAfter = insertBlocksAfter,
  acquireHubLock = defaultAcquireHubLock, releaseHubLock = defaultReleaseHubLock,
} = {}) {
  const body = buildHubLauncherBlocks({
    latestByType, childPages, hubId, overviewViewId, types, now, trustSummary,
  });
  if (dryRun) {
    console.log(`\n[dry-run] HUB "${HUB_LAUNCHER_HEADING}" (${hubId}):`);
    console.log(describeBlocks(body));
    return { wrote: false, action: 'dry-run' };
  }
  const lock = acquireHubLock();
  if (!lock.acquired) {
    console.error(`[refresh-pages] WARN: proceeding without .hub.lock after ${lock.waitedMs}ms wait (another hub writer holds it) — availability > strictness`);
  }
  try {
    const blocks = getBlocks(hubId);
    if (findSection(blocks, HUB_LAUNCHER_HEADING)) {
      replaceSection(hubId, HUB_LAUNCHER_HEADING, body);
      console.error(`[refresh-pages] hub: replaced "${HUB_LAUNCHER_HEADING}" body`);
      return { wrote: true, action: 'replaced' };
    }
    const headingBlock = { type: 'heading_2', heading_2: { rich_text: [seg(HUB_LAUNCHER_TEXT)] } };
    const firstHeadingIdx = blocks.findIndex((b) => /^heading_[123]$/.test(b?.type));
    const anchorId = firstHeadingIdx > 0 ? blocks[firstHeadingIdx - 1].id : null;
    insertAfter(hubId, anchorId, [headingBlock, ...body]);
    console.error(`[refresh-pages] hub: created "${HUB_LAUNCHER_HEADING}" (${anchorId ? `after ${anchorId}` : 'appended'})`);
    return { wrote: true, action: 'created' };
  } finally {
    if (lock.acquired) releaseHubLock();
  }
}

// --- orchestrator --------------------------------------------------------------
// Refresh all 6 child pages then the hub launcher. Each child's READ happens before
// its write, so a per-page write failure still contributes its latest row to the hub
// table. Every write is independently try/caught (non-fatal). `deps` overrides the
// transport for tests. Returns { children, hub, errors }.
//
// `onlyType` (optional) scopes the child-page WRITES to that one report type; every
// type is still queried because the hub launcher table is replaced whole and needs
// all types' latest rows. An unknown onlyType throws (config error, fail loud).
export function refreshAll({
  dryRun = false, onlyType = null, now = new Date(), trustSummary = null, deps = {},
} = {}) {
  if (onlyType != null && !REPORT_TYPES.includes(onlyType)) {
    throw new Error(`unknown --type "${onlyType}" (allowed: ${REPORT_TYPES.join(', ')})`);
  }
  const d = {
    query: queryDataSource,
    replaceSection: replaceSectionBlocks,
    getBlocks: getPageBlocks,
    findSection: findSectionBlocks,
    insertAfter: insertBlocksAfter,
    acquireHubLock: defaultAcquireHubLock,
    releaseHubLock: defaultReleaseHubLock,
    ...deps,
  };
  const results = { children: [], hub: null, errors: [] };
  const latestByType = {};

  for (const type of REPORT_TYPES) {
    const pageId = REPORT_CHILD_PAGES[type];
    let rows = [];
    let newest = null;
    try {
      ({ rows, newest } = fetchLatest(type, { query: d.query }));
    } catch (e) {
      console.error(`[refresh-pages] ERROR query "${type}" (non-fatal): ${e.message}`);
      results.errors.push({ scope: `query:${type}`, message: e.message });
      latestByType[type] = null;
      continue; // no data -> hub row shows dashes; nothing to splice into the child
    }
    latestByType[type] = extractRun(newest);

    // Scoped run: only the target type's child page is WRITTEN; the query above
    // still ran because the hub table (replaced whole below) needs every type.
    if (onlyType && type !== onlyType) {
      results.children.push({ type, pageId, rows: rows.length, wrote: false, skipped: 'scoped' });
      continue;
    }

    const blocks = buildCurrentRunBlocks(newest);
    if (dryRun) {
      console.log(`\n[dry-run] ${type} (${pageId}) — ${rows.length} row(s) -> "${CURRENT_RUN_HEADING}":`);
      console.log(describeBlocks(blocks));
      results.children.push({ type, pageId, rows: rows.length, wrote: false });
      continue;
    }
    try {
      d.replaceSection(pageId, CURRENT_RUN_HEADING, blocks);
      console.error(`[refresh-pages] ${type}: wrote "${CURRENT_RUN_HEADING}" (${rows.length} row(s))`);
      results.children.push({ type, pageId, rows: rows.length, wrote: true });
    } catch (e) {
      console.error(`[refresh-pages] ERROR write "${type}" (${pageId}) (non-fatal): ${e.message}`);
      results.errors.push({ scope: `child:${type}`, message: e.message });
      results.children.push({ type, pageId, rows: rows.length, wrote: false, error: e.message });
    }
  }

  try {
    results.hub = refreshHub({
      latestByType,
      dryRun,
      now,
      trustSummary,
      getBlocks: d.getBlocks,
      findSection: d.findSection,
      replaceSection: d.replaceSection,
      insertAfter: d.insertAfter,
      acquireHubLock: d.acquireHubLock,
      releaseHubLock: d.releaseHubLock,
    });
  } catch (e) {
    console.error(`[refresh-pages] ERROR hub launcher (non-fatal): ${e.message}`);
    results.errors.push({ scope: 'hub', message: e.message });
  }

  return results;
}

// --- CLI -----------------------------------------------------------------------
// PURE, exported for tests: extract the --type value from argv (either
// `--type <value>` or `--type=<value>`). Returns null when absent; throws when
// the flag is present but has no value.
export function parseTypeArg(argv) {
  const eq = argv.find((a) => a.startsWith('--type='));
  if (eq) return eq.slice('--type='.length);
  const idx = argv.indexOf('--type');
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val == null || val.startsWith('--')) throw new Error('--type requires a report-type value');
  return val;
}

// Best-effort, non-fatal trust-metrics computation for the hub's rollup block
// (proposal 09). A failure here (e.g. a transient ntn read) never blocks the
// page refreshes — the hub simply omits the rollup for this run and self-heals
// on the next refresh, same non-fatal contract as everything else in this file.
function computeHubTrustSummary() {
  try {
    const rawRows = queryDataSource(REPORT_RUNS_DS_ID, {});
    return computeTrustMetrics({ rawRows });
  } catch (e) {
    console.error(`[refresh-pages] WARN: trust-metrics computation failed (non-fatal, hub omits the rollup): ${e.message}`);
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const onlyType = parseTypeArg(argv);
  const trustSummary = computeHubTrustSummary();
  const results = refreshAll({ dryRun, onlyType, trustSummary });
  const wrote = results.children.filter((c) => c.wrote).length;
  const expected = onlyType ? 1 : REPORT_TYPES.length;
  const hubAction = results.hub ? results.hub.action : 'skipped';
  console.error(
    `[refresh-pages] ${dryRun ? 'DRY-RUN ' : ''}${onlyType ? `SCOPED(${onlyType}) ` : ''}done — children=${wrote}/${expected} written, `
    + `hub=${hubAction}, errors=${results.errors.length}`,
  );
  // Non-fatal by contract: per-page/hub errors are logged but never fail the sweep.
  process.exit(0);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    console.error(`[refresh-pages] FATAL: ${e.message}`);
    process.exit(2);
  }
}
