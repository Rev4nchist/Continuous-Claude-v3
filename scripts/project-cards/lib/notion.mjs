// notion.mjs — thin, deterministic wrapper over the Notion CLI (`ntn`).
// ESM, no external deps. Honors the ntn non-interactive contract on every call:
//   absolute exe, empty/closed stdin (input), hard timeout, windowsHide, fail-loud.
// See docs/notion-platform-spike-report.md and .claude/rules-ondemand/notion-cli-safety.md.
import { spawnSync } from 'node:child_process';
import {
  NTN_EXE, NTN_TIMEOUT_MS, PROJECTS_DS as PROJECTS_DS_ID,
  DECISIONS_DS as DECISIONS_DS_ID, CARD_SECTION_HEADING,
  TASKS_DS, SPONSOR_DS,
} from './config.mjs';

const NTN = NTN_EXE;

// FourthOS data source ids (databases). Re-exported from config (single source
// of truth) so existing importers of these names keep working.
export const PROJECTS_DS = PROJECTS_DS_ID;
export const DECISIONS_DS = DECISIONS_DS_ID;

// Transient failure signature — retry only these. A nonzero exit whose output
// matches rate-limiting (429/rate), a timeout, a 5xx, or a dropped connection is
// worth a backoff; anything else (bad request, auth, 4xx) fails loud immediately.
const TRANSIENT_RE = /429|rate|timeout|5\d\d|ECONN|ETIMEDOUT|Failed to execute public API request/i;
const MAX_ATTEMPTS = 3;

// Blocking sleep (spawnSync is synchronous, so async timers won't help here).
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Run ntn with the contract enforced. `input` is fed to stdin then closed so ntn
// never blocks waiting on an open pipe. Transient failures are retried up to 3
// times with exponential backoff (~0.5s / 1s / 2s); non-transient failures throw
// immediately with stderr context.
function runNtn(args, { input = '' } = {}) {
  let lastDetail = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const res = spawnSync(NTN, args, {
      input,
      timeout: NTN_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // Pin the API version: avoids a per-call OpenAPI-spec fetch (transient 403s)
      // and enables `after` on children PATCH (rejected under older versions).
      env: { ...process.env, NOTION_API_VERSION: process.env.NOTION_API_VERSION || '2025-09-03' },
    });

    if (!res.error && res.status === 0) return res.stdout;

    const detail = res.error
      ? `spawn failed: ${res.error.message}`
      : (res.stderr || res.stdout || '').trim();
    lastDetail = detail;
    const transient = TRANSIENT_RE.test(detail);

    if (transient && attempt < MAX_ATTEMPTS) {
      const backoff = 500 * 2 ** (attempt - 1); // 500, 1000, 2000
      console.error(`[ntn] transient failure [${args.join(' ')}] attempt ${attempt}/${MAX_ATTEMPTS}: ${detail} — retrying in ${backoff}ms`);
      sleepMs(backoff);
      continue;
    }

    if (res.error) throw new Error(`ntn spawn failed [${args.join(' ')}]: ${res.error.message}`);
    throw new Error(`ntn exited ${res.status} [${args.join(' ')}]: ${detail}`);
  }
  // Exhausted retries on a transient failure.
  throw new Error(`ntn failed after ${MAX_ATTEMPTS} attempts [${args.join(' ')}]: ${lastDetail}`);
}

export function ntnVersion() {
  return runNtn(['--version']).trim();
}

// POST a JSON body to a raw API path; parse and return the response object.
function apiPost(path, body) {
  const out = runNtn(['api', path, '-X', 'POST'], { input: JSON.stringify(body) });
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`ntn api ${path} returned non-JSON: ${out.slice(0, 400)}`);
  }
}

// GET a raw API path; parse and return the response object.
function apiGet(path) {
  const out = runNtn(['api', path]);
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`ntn api ${path} returned non-JSON: ${out.slice(0, 400)}`);
  }
}

// PATCH a JSON body to a raw API path; parse and return the response object.
function apiPatch(path, body) {
  const out = runNtn(['api', path, '-X', 'PATCH'], { input: JSON.stringify(body) });
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`ntn api ${path} returned non-JSON: ${out.slice(0, 400)}`);
  }
}

// DELETE a raw API path (block archive). Response body is unused.
function apiDelete(path) {
  try {
    runNtn(['api', path, '-X', 'DELETE']);
  } catch (e) {
    // Idempotent delete: a timed-out DELETE may have landed server-side, so the
    // retry sees "already archived" — that is success, not failure.
    if (/archived/i.test(String(e.message))) return;
    throw e;
  }
}

// The card heading text as stored in a Notion heading block (no Markdown '## ').
const CARD_HEADING_TEXT = CARD_SECTION_HEADING.replace(/^#+\s*/, '').trim();

// Read-back verification: true iff the page currently has an 'embed' block within
// the "## 📊 Living Status Card" section (i.e. at/after that heading and before the
// next heading_2). Used by the sweep to confirm a publish landed instead of
// trusting the claude -p stdout marker. Best-effort: returns false (not throws)
// on any read error, so a failed verification simply re-flags the card.
// Read-back verify: true iff an 'embed' block sits within the section whose
// heading_2 text matches `sectionHeading` (default: the card section). Pass the
// cockpit heading ('🎯 Portfolio Cockpit') to verify the hub cockpit embed —
// the hub and the card use DIFFERENT section headings.
export function verifyCardEmbed(pageId, sectionHeading = CARD_SECTION_HEADING) {
  if (!pageId) return false;
  const wanted = String(sectionHeading).replace(/^#+\s*/, '').trim();
  let res;
  try {
    res = apiGet(`v1/blocks/${pageId}/children`);
  } catch (e) {
    console.error(`[ntn] verifyCardEmbed read failed for ${pageId}: ${e.message}`);
    return false;
  }
  const blocks = (res && res.results) || [];
  let inSection = false;
  for (const b of blocks) {
    if (!b || typeof b.type !== 'string') continue;
    if (b.type === 'heading_2') {
      const text = (b.heading_2?.rich_text || []).map((t) => t.plain_text).join('').trim();
      // Entering the wanted section, or leaving it at the next heading_2.
      inSection = text === wanted;
      continue;
    }
    if (inSection && b.type === 'embed') return true;
  }
  return false;
}

// Query the Projects data source, paginating to EXHAUSTION. filter/sorts are raw
// Notion query objects. Routed through queryDataSource so the next_cursor walk
// (mitigation #17: a single page_size=100 call silently truncates a >100-row
// roster) and its fetched-count log are shared, single-source. `pageSize` is
// accepted for back-compat but ignored — pagination always uses 100/page.
export function queryProjects({ filter, sorts } = {}) {
  return queryDataSource(PROJECTS_DS, { filter, sorts });
}

// PURE + exported (testable without spawning ntn): resolve the intended Projects
// row from a title-`contains` query result set. Prefers an EXACT (case-insensitive)
// title match. With no exact match: a single candidate is accepted (unambiguous),
// but MORE THAN ONE candidate THROWS an ambiguous-match error rather than silently
// guessing results[0] — a substring query for "Foo" can return "Foo", "Foo v2",
// "Foobar", so guessing could resolve the WRONG project (#6). Zero rows throws
// not-found.
export function resolveProjectMatch(results, name) {
  const rows = results || [];
  if (rows.length === 0) throw new Error(`No FourthOS project matched "${name}"`);
  const lower = String(name).toLowerCase();
  const exact = rows.find((r) => title(r.properties?.Project).toLowerCase() === lower);
  if (exact) return exact;
  if (rows.length > 1) {
    const names = rows.map((r) => title(r.properties?.Project)).filter(Boolean).join(', ');
    throw new Error(
      `Ambiguous project name "${name}" matched ${rows.length} rows (${names}) `
      + 'with no exact title match — refine the name to the exact project title',
    );
  }
  return rows[0];
}

// Resolve a single Projects row by (case-insensitive) title. Paginates the
// title-`contains` query to exhaustion (#6: pageSize:10 could hide the exact
// match past page 1), then delegates the exact/ambiguous/not-found decision to
// the pure, tested resolveProjectMatch.
export function getProjectByName(name) {
  const results = queryProjects({
    filter: { property: 'Project', title: { contains: name } },
  });
  return resolveProjectMatch(results, name);
}

// Recent Decisions & Outputs rows for a project, newest first.
export function queryDecisionsForProject(projectRowId, limit = 5) {
  const body = {
    filter: { property: 'Project', relation: { contains: projectRowId } },
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    page_size: limit,
  };
  const res = apiPost(`v1/data_sources/${DECISIONS_DS}/query`, body);
  return res.results || [];
}

// Upload an HTML string as a Notion file attachment (size/precheck path).
// The authoritative embed bind is the MCP create-attachment step; this is CLI-only.
export function uploadHtml(html, filename) {
  const out = runNtn(
    ['files', 'create', '--json', '--filename', filename, '--content-type', 'text/html'],
    { input: html },
  );
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`ntn files create returned non-JSON: ${out.slice(0, 400)}`);
  }
}

// --- generic data-source query (pagination-safe) ------------------------------
// Walks next_cursor to EXHAUSTION (mitigation #4: a single 100-row page silently
// truncates larger DBs). Logs the fetched count so truncation is observable.
export function queryDataSource(dsId, { filter, sorts } = {}) {
  if (!dsId) throw new Error('queryDataSource: dsId is empty (config placeholder not filled?)');
  const all = [];
  let cursor;
  let pages = 0;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    const res = apiPost(`v1/data_sources/${dsId}/query`, body);
    all.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
    pages += 1;
  } while (cursor);
  console.error(`[ntn] queryDataSource ${dsId}: fetched ${all.length} rows in ${pages} page(s)`);
  return all;
}

// Thin wrappers over the mobile-cockpit data sources (ids filled at setup time).
export function queryTasks(dsId = TASKS_DS, opts = {}) {
  return queryDataSource(dsId, opts);
}
export function querySponsorReports(dsId = SPONSOR_DS, opts = {}) {
  return queryDataSource(dsId, opts);
}
// PM Notes (mobile PM portal). Default filter = open-status rows only (the
// queue/digest only surface open notes); caller may override via opts.filter.
// Tolerance for an EMPTY dsId lives at the caller (sweep's fetchQueueInput),
// matching the queryTasks/querySponsorReports contract.
export function queryPmNotes(dsId, opts = {}) {
  const filter = opts.filter ?? { property: 'Status', select: { equals: 'open' } };
  return queryDataSource(dsId, { ...opts, filter });
}

// --- page creation (triage executor) ------------------------------------------
// PURE body builder — testable without spawning ntn.
export function buildCreatePageBody(dsId, properties) {
  if (!dsId) throw new Error('createPage: dsId is empty (config placeholder not filled?)');
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('createPage: properties must be a plain object');
  }
  return {
    parent: { type: 'data_source_id', data_source_id: dsId },
    properties,
  };
}

// Generic row create via POST v1/pages. `post` is injectable for tests;
// defaults to the retrying apiPost (runNtn contract). Returns the created
// page object.
export function createPage(dsId, properties, { post = apiPost } = {}) {
  return post('v1/pages', buildCreatePageBody(dsId, properties));
}

// Update an existing page row's properties via PATCH v1/pages/<pageId>. This is
// the missing UPDATE path (createPage handles insert; this handles the in-place
// update the registry upsert needs when a row with the same key already exists).
// `patch` is injectable for tests; defaults to the retrying apiPatch (runNtn
// contract). Returns the updated page object.
export function updatePageProperties(pageId, properties, { patch = apiPatch } = {}) {
  if (!pageId) throw new Error('updatePageProperties: pageId is empty');
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('updatePageProperties: properties must be a plain object');
  }
  return patch(`v1/pages/${pageId}`, { properties });
}

// Trash (soft-delete) a page row via PATCH v1/pages/<id> { in_trash: true }. Used by
// the registry upsert to self-heal orphan DUPLICATE rows that share an idempotency
// key. Recoverable (Notion trash, not a hard delete). `patch` is injectable for
// tests; defaults to the retrying apiPatch (runNtn contract). Returns the page object.
export function trashPage(pageId, { patch = apiPatch } = {}) {
  if (!pageId) throw new Error('trashPage: pageId is empty');
  return patch(`v1/pages/${pageId}`, { in_trash: true });
}

// Rich-text CaptureId stamp (mitigation #3): every triage-created row carries
// the SOURCE BLOCK id so ambiguous create failures can be de-duplicated by
// querying the destination DS before any retry POST.
function captureIdProp(captureId) {
  if (!captureId) throw new Error('createRow: captureId (source block id) is required');
  return { rich_text: [{ type: 'text', text: { content: String(captureId) } }] };
}

const rt = (s) => [{ type: 'text', text: { content: String(s) } }];

// Personal Tasks DS "Priority" select options are High/Mid/Low, not the plan
// grammar's P1/P2/P3 tokens — map rather than push a mismatched new option
// into a shared personal database (mitigation #13 blast-radius care).
const PRIORITY_TO_TASKS_SELECT = { P1: 'High', P2: 'Mid', P3: 'Low' };

// Task row (personal Tasks DS). Extras: priority (select, mapped to the DS's
// own High/Mid/Low options), due (date start; DS property is "Due Date"),
// projectRelationId (relation). Returns the created page id.
export function createTaskRow(dsId, { title: name, captureId, priority, due, projectRelationId }, opts = {}) {
  const properties = {
    Task: { title: rt(name) },
    CaptureId: captureIdProp(captureId),
  };
  if (priority) properties.Priority = { select: { name: PRIORITY_TO_TASKS_SELECT[priority] || priority } };
  if (due) properties['Due Date'] = { date: { start: due } };
  if (projectRelationId) properties.Project = { relation: [{ id: projectRelationId }] };
  const page = createPage(dsId, properties, opts);
  return page.id;
}

// PM Notes row. type: note/idea/later/blocker/question; status open/addressed.
export function createPmNoteRow(dsId, { title: name, captureId, type, status, projectRelationId, source }, opts = {}) {
  const properties = {
    Note: { title: rt(name) },
    CaptureId: captureIdProp(captureId),
  };
  if (type) properties.Type = { select: { name: type } };
  if (status) properties.Status = { select: { name: status } };
  if (source) properties.Source = { select: { name: source } };
  if (projectRelationId) properties.Project = { relation: [{ id: projectRelationId }] };
  const page = createPage(dsId, properties, opts);
  return page.id;
}

// Decisions & Outputs row. The DS's title property is "Output" (not "Name").
export function createDecisionRow(dsId, { title: name, captureId, projectRelationId }, opts = {}) {
  const properties = {
    Output: { title: rt(name) },
    CaptureId: captureIdProp(captureId),
  };
  if (projectRelationId) properties.Project = { relation: [{ id: projectRelationId }] };
  const page = createPage(dsId, properties, opts);
  return page.id;
}

// Duplicate guard (mitigation #3): before retrying an ambiguous create, query
// the destination DS for an existing row stamped with this CaptureId. Returns
// the first matching row or null. `query` injectable for tests.
export function findByCaptureId(dsId, captureId, { query = queryDataSource } = {}) {
  if (!captureId) throw new Error('findByCaptureId: captureId is required');
  const rows = query(dsId, {
    filter: { property: 'CaptureId', rich_text: { equals: String(captureId) } },
  });
  return rows.length > 0 ? rows[0] : null;
}

// Archive (delete) a single block. Idempotent via apiDelete's "already
// archived" tolerance — safe for the triage crash-replay path.
export function deleteBlock(blockId) {
  if (!blockId) throw new Error('deleteBlock: blockId is required');
  apiDelete(`v1/blocks/${blockId}`);
}

// Single-block fetch (mitigation #1 snapshot→delete race: re-fetch the block
// and compare last_edited_time + text hash against the snapshot before delete).
export function getBlock(blockId) {
  if (!blockId) throw new Error('getBlock: blockId is required');
  return apiGet(`v1/blocks/${blockId}`);
}

// --- block-level section editing (mitigation #1) ------------------------------
// NEVER `ntn pages edit` full-page replace: that destroys MCP-only blocks
// (embeds, linked views) and human-owned sections. These functions touch ONLY
// the blocks between a matching heading and the next same-or-higher heading.

const HEADING_TYPES = { heading_1: 1, heading_2: 2, heading_3: 3 };

function headingLevel(block) {
  return HEADING_TYPES[block?.type] || 0;
}

function headingText(block) {
  const level = headingLevel(block);
  if (!level) return '';
  return (block[block.type]?.rich_text || []).map((t) => t.plain_text).join('').trim();
}

// Markdown heading string ('## 🚨 Attention Queue') -> { level, text }.
function parseHeading(md) {
  const m = /^(#{1,3})\s*(.*)$/.exec(String(md).trim());
  if (!m) return { level: 0, text: String(md).trim() };
  return { level: m[1].length, text: m[2].trim() };
}

// Fetch ALL child blocks of a page, walking next_cursor to exhaustion.
export function getPageBlocks(pageId) {
  const all = [];
  let cursor;
  do {
    const path = `v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const res = apiGet(path);
    all.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return all;
}

// PURE: find the section owned by `heading` (a Markdown heading string).
// Returns { headingIndex, start, end, blocks } where blocks are the section body
// (exclusive of the heading itself and of the boundary heading), or null if the
// heading is not present. The section ends at the next heading whose level is
// the SAME OR HIGHER (numerically <=) than the matched heading — so a `### `
// sub-heading stays inside a `## ` section, and the following `## 📓 Capture`
// section is never touched.
export function findSectionBlocks(blocks, heading) {
  const wanted = parseHeading(heading);
  let headingIndex = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    const lvl = headingLevel(blocks[i]);
    if (!lvl) continue;
    if ((wanted.level === 0 || lvl === wanted.level) && headingText(blocks[i]) === wanted.text) {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) return null;
  const matchedLevel = headingLevel(blocks[headingIndex]);
  let end = blocks.length;
  for (let i = headingIndex + 1; i < blocks.length; i += 1) {
    const lvl = headingLevel(blocks[i]);
    if (lvl && lvl <= matchedLevel) { end = i; break; }
  }
  return {
    headingIndex,
    start: headingIndex + 1,
    end,
    blocks: blocks.slice(headingIndex + 1, end),
  };
}

// Replace ONLY the blocks inside the `heading` section with `newBlocks`
// (an array of Notion block objects). INSERT-THEN-DELETE (never delete-first):
// the new blocks are PATCHed in immediately after the heading FIRST, and only
// once that lands are the old section blocks archived one at a time. This
// mirrors the plan's own "create-THEN-delete, never delete-first" executor
// principle (mitigation #3) at the block-replace layer: a process interrupted
// between the two steps leaves the section with DUPLICATE (old + new)
// content — recoverable and non-destructive — rather than the delete-first
// order's failure mode of a momentarily EMPTY (or, if interrupted mid-delete-
// loop, partially destroyed) section. Throws if the heading is missing — a
// silent append could land content in the wrong (human-owned) section.
export function replaceSectionBlocks(pageId, heading, newBlocks) {
  if (!pageId) throw new Error('replaceSectionBlocks: pageId is empty');
  const blocks = getPageBlocks(pageId);
  const section = findSectionBlocks(blocks, heading);
  if (!section) throw new Error(`replaceSectionBlocks: heading not found on page ${pageId}: ${heading}`);

  if (newBlocks && newBlocks.length > 0) {
    apiPatch(`v1/blocks/${pageId}/children`, {
      children: newBlocks,
      after: blocks[section.headingIndex].id,
    });
  }
  for (const b of section.blocks) {
    apiDelete(`v1/blocks/${b.id}`);
  }
  console.error(`[ntn] replaceSectionBlocks ${pageId} "${heading}": inserted ${(newBlocks || []).length}, deleted ${section.blocks.length}`);
}

// Insert `newBlocks` immediately AFTER the block `afterBlockId` on `pageId`.
// A generic primitive over the children PATCH `after` cursor (the same one
// replaceSectionBlocks uses internally) — exposed so callers can CREATE a new
// section at a chosen position (e.g. a launcher section near the top of a hub).
// When `afterBlockId` is null/undefined, Notion APPENDS at the END of the page.
// No-op on an empty block list. Returns nothing.
export function insertBlocksAfter(pageId, afterBlockId, newBlocks) {
  if (!pageId) throw new Error('insertBlocksAfter: pageId is empty');
  if (!newBlocks || newBlocks.length === 0) return;
  const body = { children: newBlocks };
  if (afterBlockId) body.after = afterBlockId;
  apiPatch(`v1/blocks/${pageId}/children`, body);
  console.error(`[ntn] insertBlocksAfter ${pageId} after=${afterBlockId || '(end)'}: inserted ${newBlocks.length}`);
}

// Update the single intro paragraph directly under `heading` WITHOUT section
// replacement. The mobile-cockpit intro lives under the page's sole heading_1,
// whose "section" (next same-or-higher heading) spans the WHOLE page — so
// replaceSectionBlocks on the H1 would delete everything (see the FOOTGUN test
// in notion-section.test.mjs). Instead: if the block immediately after the
// heading is a paragraph, PATCH just that block's rich_text; otherwise insert a
// new paragraph right after the heading. Throws if the heading is missing.
export function updateIntroParagraph(pageId, heading, text) {
  if (!pageId) throw new Error('updateIntroParagraph: pageId is empty');
  const blocks = getPageBlocks(pageId);
  const section = findSectionBlocks(blocks, heading);
  const rich = [{ type: 'text', text: { content: String(text).slice(0, 2000) } }];
  if (!section) {
    // The page title consumed the H1 at creation, so there is no heading block.
    // Fall back to the page's intro callout (the first callout block).
    const callout = blocks.find((b) => b.type === 'callout');
    if (!callout) throw new Error(`updateIntroParagraph: neither heading nor intro callout found on page ${pageId}`);
    apiPatch(`v1/blocks/${callout.id}`, { callout: { rich_text: rich } });
    console.error(`[ntn] updateIntroParagraph ${pageId}: updated intro callout ${callout.id}`);
    return;
  }
  const next = blocks[section.headingIndex + 1];
  if (next && next.type === 'paragraph') {
    apiPatch(`v1/blocks/${next.id}`, { paragraph: { rich_text: rich } });
    console.error(`[ntn] updateIntroParagraph ${pageId} "${heading}": updated paragraph ${next.id}`);
  } else {
    apiPatch(`v1/blocks/${pageId}/children`, {
      children: [{ type: 'paragraph', paragraph: { rich_text: rich } }],
      after: blocks[section.headingIndex].id,
    });
    console.error(`[ntn] updateIntroParagraph ${pageId} "${heading}": inserted new paragraph`);
  }
}

// --- property extractors (raw Notion property object -> primitive) ---
export const title = (p) => (p?.title || []).map((t) => t.plain_text).join('');
export const richText = (p) => (p?.rich_text || []).map((t) => t.plain_text).join('');
export const selectName = (p) => p?.select?.name || '';
export const statusName = (p) => p?.status?.name || p?.select?.name || '';
export const checkbox = (p) => !!p?.checkbox;
export const urlVal = (p) => p?.url || '';
export const multiSelect = (p) => (p?.multi_select || []).map((s) => s.name);
export const dateStart = (p) => p?.date?.start || '';
