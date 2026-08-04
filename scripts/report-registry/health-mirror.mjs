// health-mirror.mjs — deterministic (ntn-only, NO MCP) mirror of the newest CCv3
// health-check result onto the "CCv3 Weekly Health Checks" Notion page. Replaces the
// claude -p + notion-health-prompt.md step in scripts/scheduled-health-check.bat: the
// mirror is ~90% mechanical (read the newest health_*.json, rewrite three machine-owned
// sections), so an LLM round-trip added cost, a permission-grant footgun (see the
// headless-claude-mcp rule), and non-determinism for no synthesis value.
//
// What it writes (all via lib/notion.mjs's block-level section splice — NEVER a full-page
// edit, so MCP-only blocks and human-owned sections are untouched):
//   1. `## Current Status — Week of <date>` — a 2-col Field/Value table (Overall, Counts,
//      Duration, Scheduler, Context) + a `### Critical Path — …` heading + evidence bullets.
//      The heading carries the week label, so it DRIFTS run-to-run → matched by PREFIX.
//   2. `## Run Log` — prepend today's row (Date · Status · PASS/WARN/FAIL · Duration · Notes)
//      to the existing table, keeping history. Idempotent: a re-mirror of the SAME run
//      (same local minute key) REPLACES its own row instead of appending a duplicate.
//   3. `## WARN Breakdown (<n> items)` — one row per WARN/FAIL from this run (with an Age
//      column vs the immediately-preceding run) + a trailing paragraph noting resolutions.
//      The heading carries the item count → matched by PREFIX.
//
// SECTION OWNERSHIP (do NOT extend without care): this script writes ONLY the three
// sections above. `## Your Suggested Actions`, `## Improvement Ideas`, and
// `## Automation — How This Page Gets Updated` are human/LLM-owned and are NEVER touched —
// leave those to a human or a future LLM pass.
//
// NON-FATAL: each of the three section writes is independently try/caught (matching
// refresh-pages.mjs) — one failing section logs `[health-mirror] ERROR …` and the run
// continues; the CLI exits 0 on success/partial (a dashboard mirror must never fail the
// parent health-check task). A top-level config/IO fatal (no health JSON, bad page) exits 2.
//
// CLI:
//   node health-mirror.mjs            # mirror the newest health_*.json onto the page
//   node health-mirror.mjs --dry-run  # print the planned section writes; write nothing
//   node health-mirror.mjs --file <path>  # mirror a specific health_*.json (testing)
//
// Reuses scripts/project-cards/lib/notion.mjs (absolute-NTN_EXE non-interactive contract).
// ESM, no external deps.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getPageBlocks, findSectionBlocks, replaceSectionBlocks,
  insertBlocksAfter, deleteBlock,
} from '../project-cards/lib/notion.mjs';

// report-registry ROOT (this dir) -> repo root (two up).
const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(ROOT, '..', '..');
export const HEALTH_CACHE_DIR = join(REPO_ROOT, '.claude', 'cache', 'health-checks');

// The "CCv3 Weekly Health Checks" dashboard page (job-owned by the health-check task).
export const HEALTH_PAGE_ID = '34c76fd7-ac82-80a9-84af-c486a9844290';

// The three section headings this mirror owns. Current Status + WARN Breakdown carry a
// dynamic suffix (week label / item count) so they are matched by PREFIX, not exact text;
// Run Log is stable and matched exactly by findSectionBlocks/replaceSectionBlocks.
export const CURRENT_STATUS_PREFIX = 'Current Status';
export const RUN_LOG_HEADING = '## Run Log';
export const WARN_BREAKDOWN_PREFIX = 'WARN Breakdown';

// The critical-path checks (all must PASS for the path to read "green"), grouped for the
// Current Status evidence bullets. Each group renders the checks present in the results.
const CRITICAL_PATH_CHECKS = ['docker-daemon-running', 'postgres-container-running', 'rlm-sandbox-image-present'];
const CRITICAL_PATH_BULLET_GROUPS = [
  CRITICAL_PATH_CHECKS,
  ['memory-connection', 'memory-canary-roundtrip'],
  ['hook-dist-freshness', 'hook-registrations-valid'],
  ['sync-drift-skills', 'sync-drift-rules', 'sync-drift-agents', 'git-remote-sync'],
  ['knowledge-tree-present'],
];

// overall_status -> traffic-light emoji / display label. Unknown -> the WORST light
// (fail-safe: never render an unrecognized status as green).
const STATUS_EMOJI = { PASS: '🟢', WARN: '🟡', HIGH_FAIL: '🟠', CRITICAL_FAIL: '🔴' };
const STATUS_LABEL = { PASS: 'PASS', WARN: 'WARN', HIGH_FAIL: 'HIGH FAIL', CRITICAL_FAIL: 'CRITICAL' };
export const statusEmoji = (s) => STATUS_EMOJI[s] || '🔴';
export const statusLabel = (s) => STATUS_LABEL[s] || String(s || 'UNKNOWN');

// --- small formatting helpers (pure) -------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
// LOCAL date/time (the scheduled task runs in machine-local time, and the existing Run
// Log rows use local — so the dedup key matches the on-page rows).
export function formatLocalDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function formatLocalDateTime(d) {
  return `${formatLocalDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// Strip ANSI escapes + collapse whitespace; trim to a cell-friendly length.
export function cleanEvidence(s, max = 140) {
  const t = String(s ?? '').replace(/\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Next scheduled Friday STRICTLY after `from` (the task fires Fridays 08:03). If `from`
// is itself a Friday, returns the following Friday (+7).
export function nextFriday(from) {
  const d = new Date(from);
  const day = d.getDay(); // 0=Sun … 5=Fri … 6=Sat
  let add = (5 - day + 7) % 7;
  if (add === 0) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

// --- summary derivation (pure) -------------------------------------------------
// Fold a raw health_*.json object into the primitives every renderer needs. `now` and
// `previousWarnNames` are injected so this stays pure/testable. WARN+FAIL entries are
// collected FAIL-first; each is aged against the immediately-preceding run's WARN set
// ('pre-existing' if seen there, else 'new'); `resolved` is that prior set minus this run's.
export function summarizeHealth(json, { previousWarnNames = new Set(), now = new Date() } = {}) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const byName = new Map(results.map((r) => [r.name, r]));
  const counts = json?.counts || {};
  const PASS = counts.PASS || 0;
  const WARN = counts.WARN || 0;
  const FAIL = counts.FAIL || 0;
  const SKIP = counts.SKIP || 0;
  const total = PASS + WARN + FAIL + SKIP;
  const critical = results.filter((r) => r.status === 'FAIL' && r.severity === 'CRITICAL').length;

  const run = json?.timestamp ? new Date(json.timestamp) : new Date(now);
  const durationS = Number(json?.duration_s) || 0;
  const overallStatus = json?.overall_status || 'CRITICAL_FAIL';

  const rank = (s) => (s === 'FAIL' ? 0 : 1); // FAIL before WARN
  const warns = results
    .filter((r) => r.status === 'WARN' || r.status === 'FAIL')
    .sort((a, b) => rank(a.status) - rank(b.status))
    .map((r, i) => ({
      index: i + 1,
      name: r.name,
      status: r.status,
      severity: r.severity || 'INFO',
      evidence: cleanEvidence(r.evidence),
      age: previousWarnNames.has(r.name) ? 'pre-existing' : 'new',
    }));
  const currentNames = new Set(warns.map((w) => w.name));
  const resolved = [...previousWarnNames].filter((n) => !currentNames.has(n));

  const criticalPathAllGreen = CRITICAL_PATH_CHECKS.every((n) => byName.get(n)?.status === 'PASS');
  const nf = nextFriday(run);

  return {
    counts: { PASS, WARN, FAIL, SKIP },
    total,
    critical,
    overallStatus,
    overallEmoji: statusEmoji(overallStatus),
    overallLabel: statusLabel(overallStatus),
    durationS,
    durationLabel: `${durationS.toFixed(1)}s`,
    runLocal: run,
    dateKey: formatLocalDateTime(run),
    weekLabel: formatLocalDate(run),
    nextRun: formatLocalDate(nf),
    nextRunLabel: `${formatLocalDate(nf)} 08:03 AM`,
    criticalPathAllGreen,
    warns,
    resolved,
    byName,
  };
}

// --- rich-text + table primitives (pure) ---------------------------------------
// One Notion rich_text segment (2000-char cap; optional bold).
function seg(content, { bold } = {}) {
  const o = { type: 'text', text: { content: String(content ?? '').slice(0, 2000) } };
  if (bold) o.annotations = { bold: true };
  return o;
}
const cell = (...segs) => segs;
const tableRow = (cells) => ({ type: 'table_row', table_row: { cells } });
const boldRow = (labels) => tableRow(labels.map((l) => cell(seg(l, { bold: true }))));
function table(width, rows) {
  return {
    type: 'table',
    table: {
      table_width: width, has_column_header: true, has_row_header: false, children: rows,
    },
  };
}

// --- Current Status builders (pure) --------------------------------------------
export function currentStatusHeading(summary) {
  return `${CURRENT_STATUS_PREFIX} — Week of ${summary.weekLabel}`;
}

// The critical-path evidence bullets: one per group, listing each present check as
// `<name> <STATUS> (<evidence>)`. Missing checks are simply omitted.
export function buildCriticalPathBullets(byName) {
  const bullets = [];
  for (const group of CRITICAL_PATH_BULLET_GROUPS) {
    const parts = [];
    for (const name of group) {
      const r = byName.get(name);
      if (!r) continue;
      const ev = cleanEvidence(r.evidence, 60);
      parts.push(ev ? `${name} ${r.status} (${ev})` : `${name} ${r.status}`);
    }
    if (parts.length) {
      bullets.push({
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [seg(parts.join(' · '))] },
      });
    }
  }
  return bullets;
}

// The Current Status section BODY: a 2-col Field/Value table + the Critical Path heading_3
// + evidence bullets. Deterministic prose in the Context row.
export function buildCurrentStatusBlocks(summary) {
  const { counts: c, total } = summary;
  const overall = `${summary.overallEmoji} ${summary.overallLabel} (${c.FAIL} FAIL / ${summary.critical} CRITICAL)`;
  const countsCell = `${c.PASS} PASS · ${c.WARN} WARN · ${c.FAIL} FAIL · ${c.SKIP} SKIP (${total} checks)`;
  const scheduler = `CCv3-Health-Check NextRun=${summary.nextRunLabel}`;
  const context = `${summary.overallLabel} weekly scheduled run. ${c.SKIP} checks SKIPPED by design `
    + '(--skip-slow: memory canary, RLM/opc test suites, external API probes). '
    + `${c.WARN} WARN, ${c.FAIL} FAIL — critical path ${summary.criticalPathAllGreen ? 'green' : 'needs attention'}.`;

  const statusTable = table(2, [
    boldRow(['Field', 'Value']),
    tableRow([cell(seg('Overall', { bold: true })), cell(seg(overall))]),
    tableRow([cell(seg('Counts', { bold: true })), cell(seg(countsCell))]),
    tableRow([cell(seg('Duration', { bold: true })), cell(seg(summary.durationLabel))]),
    tableRow([cell(seg('Scheduler', { bold: true })), cell(seg(scheduler))]),
    tableRow([cell(seg('Context', { bold: true })), cell(seg(context))]),
  ]);
  const cpLabel = summary.criticalPathAllGreen ? 'All Green ✅' : 'Attention Needed ⚠️';
  const cpHeading = { type: 'heading_3', heading_3: { rich_text: [seg(`Critical Path — ${cpLabel}`)] } };
  return [statusTable, cpHeading, ...buildCriticalPathBullets(summary.byName)];
}

// --- Run Log builders (pure) ---------------------------------------------------
// A short (<=10-word) human note derived from the counts.
export function runLogNote(summary) {
  const { FAIL, WARN } = summary.counts;
  if (FAIL > 0) return `${FAIL} FAIL — investigate`;
  if (WARN > 0) return `Nominal — ${WARN} WARN, 0 FAIL`;
  return 'All green — nominal run';
}

// The new Run Log row for this run.
export function buildRunLogRow(summary) {
  const { PASS, WARN, FAIL } = summary.counts;
  return tableRow([
    cell(seg(summary.dateKey)),
    cell(seg(`${summary.overallEmoji} ${summary.overallLabel}`)),
    cell(seg(`${PASS} / ${WARN} / ${FAIL}`)),
    cell(seg(`${Math.round(summary.durationS)}s`)),
    cell(seg(runLogNote(summary))),
  ]);
}

// Rebuild the Run Log table: header + this run's row + the kept prior data rows. `keptRows`
// is an array of { cells: string[] } (prior rows already de-duped against today's key).
export function buildRunLogTable(newRow, keptRows) {
  const header = boldRow(['Date', 'Status', 'PASS/WARN/FAIL', 'Duration', 'Notes']);
  const prior = keptRows.map((r) => tableRow((r.cells || []).map((t) => cell(seg(t)))));
  return table(5, [header, newRow, ...prior]);
}

// --- WARN Breakdown builders (pure) --------------------------------------------
export function warnBreakdownHeading(summary) {
  const n = summary.warns.length;
  return `${WARN_BREAKDOWN_PREFIX} (${n} item${n === 1 ? '' : 's'})`;
}

// The WARN Breakdown section BODY: a 5-col table (# · Check · Severity · Evidence · Age),
// one row per WARN/FAIL, plus a trailing paragraph noting resolutions since the prior run.
export function buildWarnBreakdownBlocks(summary) {
  const header = boldRow(['#', 'Check', 'Severity', 'Evidence', 'Age']);
  const rows = summary.warns.map((w) => tableRow([
    cell(seg(String(w.index))),
    cell(seg(w.name)),
    cell(seg(w.severity)),
    cell(seg(w.evidence)),
    cell(seg(w.age)),
  ]));
  const warnTable = table(5, [header, ...(rows.length ? rows : [
    tableRow([cell(seg('—')), cell(seg('none this run')), cell(seg('—')), cell(seg('—')), cell(seg('—'))]),
  ])]);

  const lead = summary.counts.FAIL > 0
    ? `${summary.counts.FAIL} FAIL this run — see evidence above.`
    : 'None of these degrade the critical path — polish items.';
  const resolvedText = summary.resolved.length
    ? ` Resolved since the previous run: ${summary.resolved.join(', ')}.`
    : ' No WARNs resolved since the previous run.';
  const para = { type: 'paragraph', paragraph: { rich_text: [seg(lead + resolvedText)] } };
  return [warnTable, para];
}

// --- dry-run rendering (pure) --------------------------------------------------
function flatRich(rich) {
  return (rich || []).map((s) => s.text?.content ?? '').join('');
}
// Human-readable one-liner(s) for a block array, for --dry-run output (mirrors
// refresh-pages.describeBlocks, extended for headings/bullets/table_row).
export function describeBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === 'heading_2') out.push(`  ## ${flatRich(b.heading_2.rich_text)}`);
    else if (b.type === 'heading_3') out.push(`  ### ${flatRich(b.heading_3.rich_text)}`);
    else if (b.type === 'paragraph') out.push(`  paragraph: ${flatRich(b.paragraph.rich_text)}`);
    else if (b.type === 'callout') out.push(`  callout: ${flatRich(b.callout.rich_text)}`);
    else if (b.type === 'bulleted_list_item') out.push(`  • ${flatRich(b.bulleted_list_item.rich_text)}`);
    else if (b.type === 'table') {
      out.push(`  table (${b.table.table_width} cols, ${b.table.children.length} rows):`);
      for (const r of b.table.children) {
        out.push(`    | ${r.table_row.cells.map((c) => flatRich(c)).join(' | ')} |`);
      }
    } else if (b.type === 'table_row') {
      out.push(`    | ${b.table_row.cells.map((c) => flatRich(c)).join(' | ')} |`);
    } else out.push(`  ${b.type}`);
  }
  return out.join('\n');
}

// --- prefix section splice (transport-injectable) ------------------------------
// PURE: locate a `heading_2` section by a TEXT PREFIX (the dynamic-suffix headings drift
// run-to-run). Returns { headingIdx, headingId, anchorId, oldHeadingText, body } where
// `body` is the block slice between the heading and the next heading_1/heading_2 (a
// heading_3 stays INSIDE, so the Critical Path sub-heading is part of the body). Returns
// null if absent; throws if the section is the first block (no anchor to insert after).
export function sectionBounds(blocks, prefix) {
  const p = String(prefix).trim();
  const h2text = (b) => (b.heading_2?.rich_text || []).map((t) => t.plain_text).join('').trim();
  let idx = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].type === 'heading_2' && h2text(blocks[i]).startsWith(p)) { idx = i; break; }
  }
  if (idx === -1) return null;
  if (idx === 0) throw new Error(`sectionBounds: section "${prefix}" has no preceding anchor block`);
  let end = blocks.length;
  for (let i = idx + 1; i < blocks.length; i += 1) {
    if (blocks[i].type === 'heading_1' || blocks[i].type === 'heading_2') { end = i; break; }
  }
  return {
    headingIdx: idx,
    headingId: blocks[idx].id,
    anchorId: blocks[idx - 1].id,
    oldHeadingText: h2text(blocks[idx]),
    body: blocks.slice(idx + 1, end),
  };
}

// Replace a dynamic-heading section (heading + body) in place. INSERT-THEN-DELETE (never
// delete-first, mirroring replaceSectionBlocks): the new [heading, ...body] is inserted
// after the block preceding the old heading FIRST, then the old heading + old body blocks
// are archived. An interruption between the two steps leaves a DUPLICATE (recoverable)
// section rather than an empty/destroyed one. Throws if the section is missing (a silent
// append could land content in a human-owned section).
export function spliceSection(pageId, { prefix, headingText, body }, {
  dryRun = false, getBlocks = getPageBlocks, insertAfter = insertBlocksAfter, del = deleteBlock,
} = {}) {
  if (dryRun) {
    console.log(`\n[dry-run] "${headingText}" (prefix "${prefix}"):`);
    console.log(describeBlocks([{ type: 'heading_2', heading_2: { rich_text: [seg(headingText)] } }, ...body]));
    return { wrote: false, prefix };
  }
  const blocks = getBlocks(pageId);
  const b = sectionBounds(blocks, prefix);
  if (!b) throw new Error(`spliceSection: section "${prefix}" not found on page ${pageId}`);
  const headingBlock = { type: 'heading_2', heading_2: { rich_text: [seg(headingText)] } };
  insertAfter(pageId, b.anchorId, [headingBlock, ...body]);
  del(b.headingId);
  for (const ob of b.body) del(ob.id);
  console.error(`[health-mirror] spliced "${headingText}" (replaced heading + ${b.body.length} body block(s))`);
  return { wrote: true, prefix, replaced: b.body.length + 1 };
}

// --- Run Log table read (transport-injectable) ---------------------------------
// Read the existing Run Log table's DATA rows (header excluded) as { tableId, dataRows }
// where each dataRow is { cells: string[] }. Uses findSectionBlocks (exact '## Run Log'
// match — the heading is stable) to locate the table, then getPageBlocks(tableId) to read
// its row children. Throws if the section/table is missing.
export function readRunLogRows(pageId, { getBlocks = getPageBlocks, findSection = findSectionBlocks } = {}) {
  const blocks = getBlocks(pageId);
  const section = findSection(blocks, RUN_LOG_HEADING);
  if (!section) throw new Error(`readRunLogRows: "${RUN_LOG_HEADING}" not found on page ${pageId}`);
  const tbl = section.blocks.find((b) => b.type === 'table');
  if (!tbl) throw new Error(`readRunLogRows: no table under "${RUN_LOG_HEADING}"`);
  const rows = getBlocks(tbl.id);
  const cellText = (c) => (c || []).map((t) => t.plain_text).join('');
  const dataRows = rows
    .filter((r) => r.type === 'table_row')
    .slice(1) // drop the header row
    .map((r) => ({ cells: (r.table_row?.cells || []).map(cellText) }));
  return { tableId: tbl.id, dataRows };
}

// --- section refreshers (transport-injectable) ---------------------------------
export function refreshCurrentStatus(pageId, summary, deps = {}) {
  return spliceSection(pageId, {
    prefix: CURRENT_STATUS_PREFIX,
    headingText: currentStatusHeading(summary),
    body: buildCurrentStatusBlocks(summary),
  }, deps);
}

export function refreshWarnBreakdown(pageId, summary, deps = {}) {
  return spliceSection(pageId, {
    prefix: WARN_BREAKDOWN_PREFIX,
    headingText: warnBreakdownHeading(summary),
    body: buildWarnBreakdownBlocks(summary),
  }, deps);
}

// Prepend today's Run Log row (idempotent by the local-minute date key: a re-mirror of the
// same run drops its own prior row before re-adding it). Rebuilds the whole table via
// replaceSectionBlocks so the write is deterministic (no reliance on table-row `after`).
export function refreshRunLog(pageId, summary, {
  dryRun = false, getBlocks = getPageBlocks, findSection = findSectionBlocks,
  replaceSection = replaceSectionBlocks, readRows = readRunLogRows,
} = {}) {
  const newRow = buildRunLogRow(summary);
  let dataRows = [];
  try {
    ({ dataRows } = readRows(pageId, { getBlocks, findSection }));
  } catch (e) {
    if (dryRun) { console.log(`\n[dry-run] Run Log: could not read existing rows (${e.message}) — showing new row only`); }
    else throw e;
  }
  const kept = dataRows.filter((r) => (r.cells?.[0] || '') !== summary.dateKey);
  const tbl = buildRunLogTable(newRow, kept);
  if (dryRun) {
    console.log(`\n[dry-run] "${RUN_LOG_HEADING}" — prepend 1 row, keep ${kept.length} prior:`);
    console.log(describeBlocks([tbl]));
    return { wrote: false, kept: kept.length };
  }
  replaceSection(pageId, RUN_LOG_HEADING, [tbl]);
  console.error(`[health-mirror] Run Log: prepended 1 row, kept ${kept.length} prior`);
  return { wrote: true, kept: kept.length };
}

// --- orchestrator --------------------------------------------------------------
// Mirror one summary onto the page's three machine-owned sections. Each section write is
// independently try/caught (non-fatal); returns { sections, errors }.
export function mirrorHealth(summary, { pageId = HEALTH_PAGE_ID, dryRun = false, deps = {} } = {}) {
  const sections = [];
  const errors = [];
  const steps = [
    ['current-status', () => refreshCurrentStatus(pageId, summary, { dryRun, ...deps })],
    ['run-log', () => refreshRunLog(pageId, summary, { dryRun, ...deps })],
    ['warn-breakdown', () => refreshWarnBreakdown(pageId, summary, { dryRun, ...deps })],
  ];
  for (const [name, fn] of steps) {
    try {
      sections.push({ name, ...fn() });
    } catch (e) {
      console.error(`[health-mirror] ERROR ${name} (non-fatal): ${e.message}`);
      errors.push({ scope: name, message: e.message });
      sections.push({ name, wrote: false, error: e.message });
    }
  }
  return { sections, errors };
}

// --- file discovery (I/O) ------------------------------------------------------
// Newest health_*.json in the cache dir by filename (the YYYYMMDD_HHMMSS stamp sorts
// lexicographically). Returns an absolute path or null if none.
export function findHealthJsons(dir = HEALTH_CACHE_DIR) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^health_\d{8}_\d{6}\.json$/.test(n))
    .sort() // ascending; newest last
    .map((n) => join(dir, n));
}

// Read the newest run's JSON and the WARN/FAIL name set of the immediately-preceding run
// (for the Age column / resolved list). previousWarnNames is EMPTY when there is no prior
// file — a genuinely first-ever run, where every WARN then reads as 'new' (no baseline to
// compare) and `resolved` is []. In practice the cache always holds prior runs, so ages are
// computed against the run just before this one.
//
// FRESHNESS GUARD (2026-08-04): "newest by filename" is NOT "this run's output". If the
// python run crashed before writing (or never launched: 9009), the newest file is LAST
// week's — and mirroring it would re-publish old data as fresh, page saying PASS while the
// registry row disagrees. The Run Log's dedup-by-dateKey then hides the re-splice. So the
// newest JSON must be recent (default 6h — the scheduled chain runs the mirror minutes
// after the check). A stale or unparseable timestamp THROWS; main() maps that to the
// grep-able `health-mirror: STALE` line + exit 2 instead of publishing.
export const STALE_MAX_AGE_HOURS = 6;
export function loadRuns(dir = HEALTH_CACHE_DIR, { maxAgeHours = STALE_MAX_AGE_HOURS, now = Date.now() } = {}) {
  const files = findHealthJsons(dir);
  if (files.length === 0) throw new Error(`no health_*.json found in ${dir}`);
  const newestPath = files[files.length - 1];
  const json = JSON.parse(readFileSync(newestPath, 'utf8'));
  const ts = Date.parse(json.timestamp);
  if (!Number.isFinite(ts)) {
    throw new Error(`STALE: newest ${newestPath} has missing/unparseable timestamp `
      + `${JSON.stringify(json.timestamp ?? null)} — refusing to mirror unverifiable data`);
  }
  const ageHours = (now - ts) / 3_600_000;
  if (ageHours > maxAgeHours) {
    throw new Error(`STALE: newest ${newestPath} is ${ageHours.toFixed(1)}h old `
      + `(threshold ${maxAgeHours}h) — this run likely wrote no JSON; refusing to re-publish `
      + `the previous run's data as fresh`);
  }
  let previousWarnNames = new Set();
  if (files.length >= 2) {
    try {
      const prev = JSON.parse(readFileSync(files[files.length - 2], 'utf8'));
      previousWarnNames = new Set(
        (prev.results || []).filter((r) => r.status === 'WARN' || r.status === 'FAIL').map((r) => r.name),
      );
    } catch { /* prior unreadable -> no baseline; ages read as pre-existing */ }
  }
  return { newestPath, json, previousWarnNames };
}

// --- CLI -----------------------------------------------------------------------
function parseFileArg(argv) {
  const eq = argv.find((a) => a.startsWith('--file='));
  if (eq) return eq.slice('--file='.length);
  const idx = argv.indexOf('--file');
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val == null || val.startsWith('--')) throw new Error('--file requires a path value');
  return val;
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const fileArg = parseFileArg(argv);

  let json;
  let previousWarnNames = new Set();
  if (fileArg) {
    json = JSON.parse(readFileSync(fileArg, 'utf8'));
  } else {
    ({ json, previousWarnNames } = loadRuns());
  }
  const summary = summarizeHealth(json, { previousWarnNames });

  const { sections, errors } = mirrorHealth(summary, { dryRun });
  const wrote = sections.filter((s) => s.wrote).length;
  console.error(
    `[health-mirror] ${dryRun ? 'DRY-RUN ' : ''}done — sections=${wrote}/3 written, errors=${errors.length}`,
  );
  const c = summary.counts;
  const marker = errors.length === 0 ? (dryRun ? 'DRY-RUN' : 'OK') : 'PARTIAL';
  // Grep-able outcome line for the scheduled log (mirrors the old prompt's marker).
  console.log(`health-mirror: ${marker} status=${summary.overallStatus} counts=${c.PASS}/${c.WARN}/${c.FAIL}/${c.SKIP}`);
  // Non-fatal by contract: per-section errors are logged but never fail the parent task.
  process.exit(0);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    // STALE disclosure path: the freshness guard in loadRuns throws with a STALE:
    // prefix; surface it as its own grep-able outcome line (the dated log's last
    // line is what an operator reads) instead of a generic FATAL.
    const stale = /^STALE:/.test(e.message);
    console.error(`[health-mirror] ${stale ? e.message : `FATAL: ${e.message}`}`);
    if (stale) console.log('health-mirror: STALE nothing published (see stderr)');
    process.exit(2);
  }
}
