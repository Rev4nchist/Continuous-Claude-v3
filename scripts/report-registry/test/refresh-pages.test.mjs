// refresh-pages.test.mjs — pure tests for the Phase-3 refresh builders +
// orchestration (mocked transport; no ntn spawn). Verifies:
//   - the "Current run" callout builder (populated + empty cases + link guard)
//   - the hub launcher table builder (links, status/date cells, non-http guard)
//   - notionPageUrl / notionViewUrl formatting
//   - extractRun / pickNewest row helpers
//   - refreshAll orchestration: right DS filter/sort, splices to '## Current run',
//     non-fatal per page, hub still runs, dry-run touches nothing.
// Run: node --test scripts/report-registry/test/refresh-pages.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notionPageUrl, notionViewUrl, extractRun, pickNewest, watchdogVerdict,
  buildCurrentRunBlocks, buildHubLauncherBlocks,
  refreshChildPage, refreshHub, refreshAll, parseTypeArg,
  CURRENT_RUN_HEADING, HUB_LAUNCHER_HEADING,
} from '../refresh-pages.mjs';
import { REPORT_CHILD_PAGES } from '../config.mjs';

// --- helpers to fabricate raw Notion rows ---
function row({ runDate, status, summary, artifactUrl, title } = {}) {
  const p = {};
  if (runDate !== undefined) p['Run Date'] = { date: { start: runDate } };
  if (status !== undefined) p.Status = { select: { name: status } };
  if (summary !== undefined) p.Summary = { rich_text: [{ plain_text: summary }] };
  if (artifactUrl !== undefined) p['Artifact URL'] = { url: artifactUrl };
  if (title !== undefined) p['Report Run'] = { title: [{ plain_text: title }] };
  return { properties: p };
}

// pull the flat plain-text of a rich_text array
const flat = (rich) => (rich || []).map((s) => s.text?.content ?? '').join('');
const findCallout = (blocks) => blocks.find((b) => b.type === 'callout');
const findTable = (blocks) => blocks.find((b) => b.type === 'table');

// --- url formatting ------------------------------------------------------------

test('notionPageUrl strips dashes and builds the canonical page url', () => {
  assert.equal(
    notionPageUrl('39576fd7-ac82-817d-9658-d2c8b7f84ad2'),
    'https://www.notion.so/39576fd7ac82817d9658d2c8b7f84ad2',
  );
});

test('notionViewUrl deep-links a view block on a page (page#view)', () => {
  assert.equal(
    notionViewUrl('38f76fd7ac8280478e50dd2956ba6e8a', '39576fd7-ac82-81d6-be38-000ce9bbd794'),
    'https://www.notion.so/38f76fd7ac8280478e50dd2956ba6e8a#39576fd7ac8281d6be38000ce9bbd794',
  );
});

// --- extractRun / pickNewest ---------------------------------------------------

test('extractRun normalizes a raw row; null on an empty/absent row', () => {
  const r = extractRun(row({ runDate: '2026-06-29', status: 'OK', summary: 'hi', artifactUrl: 'https://x/y' }));
  assert.deepEqual(
    { runDate: r.runDate, status: r.status, summary: r.summary, artifactUrl: r.artifactUrl },
    { runDate: '2026-06-29', status: 'OK', summary: 'hi', artifactUrl: 'https://x/y' },
  );
  assert.equal(extractRun(null), null);
  assert.equal(extractRun({}), null);
});

test('pickNewest picks the chronologically newest row across mixed tz (not lexicographic)', () => {
  const rows = [
    row({ runDate: '2026-07-09T10:00:00Z' }),
    row({ runDate: '2026-07-09T06:00:00-05:00' }), // == 11:00Z -> newest
  ];
  assert.equal(dateOf(pickNewest(rows)), '2026-07-09T06:00:00-05:00');
  assert.equal(pickNewest([]), null);
});
function dateOf(r) { return r?.properties?.['Run Date']?.date?.start; }

test('pickNewest: a genuine row wins over a same-period watchdog: miss-row even when the miss-row is newer (WS1b)', () => {
  // Once genuine Self-Improvement rows land again, a same-period `watchdog:` Failed
  // miss-row (written earlier, TODAY's date) must NOT win over the genuine success.
  const rows = [
    row({ runDate: '2026-07-20T02:00:00Z', status: 'Failed', summary: 'watchdog: no "Self-Improvement" row found for period 2026-07-20 by its deadline+grace' }),
    row({ runDate: '2026-07-20T00:30:00Z', status: 'OK', summary: 'daily-sweep: proposal recorded (docs/self-improvement/proposals/2026-07-20-x.md)' }),
  ];
  const picked = pickNewest(rows);
  assert.equal(picked.properties.Status.select.name, 'OK'); // the genuine row, not the newer miss
});

test('pickNewest: a period with ONLY a watchdog: miss-row still surfaces the miss (falls back to all)', () => {
  const rows = [
    row({ runDate: '2026-07-20T02:00:00Z', status: 'Failed', summary: 'watchdog: no "Self-Improvement" row found for period 2026-07-20 by its deadline+grace' }),
  ];
  const picked = pickNewest(rows);
  assert.ok(picked, 'a period with only a miss-row still returns it (verdict -> missing), not null');
  assert.match(picked.properties.Summary.rich_text[0].plain_text, /^watchdog:/);
});

// --- Current run callout builder -----------------------------------------------

test('buildCurrentRunBlocks(null) -> a single "No runs recorded yet." callout (italic)', () => {
  const blocks = buildCurrentRunBlocks(null);
  assert.equal(blocks.length, 1);
  const c = findCallout(blocks);
  assert.ok(c, 'is a callout');
  assert.match(flat(c.callout.rich_text), /No runs recorded yet\./);
  assert.equal(c.callout.rich_text[0].annotations?.italic, true);
});

test('buildCurrentRunBlocks(row) -> callout: bold "Latest:", run date, bold status, summary', () => {
  const blocks = buildCurrentRunBlocks(row({ runDate: '2026-06-29', status: 'OK', summary: 'VP Weekly report 2026-W27' }));
  const c = findCallout(blocks);
  const text = flat(c.callout.rich_text);
  assert.match(text, /Latest:/);
  assert.match(text, /2026-06-29/);
  assert.match(text, /OK/);
  assert.match(text, /VP Weekly report 2026-W27/);
  // "Latest:" segment is bold; a status segment is bold.
  const boldTexts = c.callout.rich_text.filter((s) => s.annotations?.bold).map((s) => s.text.content);
  assert.ok(boldTexts.some((t) => /Latest:/.test(t)), 'Latest label bold');
  assert.ok(boldTexts.some((t) => /OK/.test(t)), 'status bold');
});

test('buildCurrentRunBlocks: http artifact becomes a link; non-http path renders NO link', () => {
  const withUrl = findCallout(buildCurrentRunBlocks(row({ runDate: '2026-06-29', status: 'OK', artifactUrl: 'https://rev4nchist.github.io/x/' })));
  const linkSeg = withUrl.callout.rich_text.find((s) => s.text?.link);
  assert.equal(linkSeg.text.link.url, 'https://rev4nchist.github.io/x/');

  const withPath = findCallout(buildCurrentRunBlocks(row({ runDate: '2026-07-05', status: 'OK', artifactUrl: 'docs/self-improvement/proposals/2026-07-05-observability.md' })));
  assert.equal(withPath.callout.rich_text.some((s) => s.text?.link), false, 'no link for a non-http path');
});

// --- Hub launcher table builder ------------------------------------------------

const CHILD = {
  'VP Weekly': '39576fd7-ac82-817d-9658-d2c8b7f84ad2',
  'Team Dashboard': '39576fd7-ac82-810b-9fc8-c2d1f4f76fc3',
};

// Fixed "now" so nextExpectedLabel/watchdogVerdict (SCHEDULE-driven) are deterministic.
const HUB_NOW = new Date(2026, 6, 16, 13, 0, 0); // Thursday 13:00

test('buildHubLauncherBlocks -> a table (header + one row per type) + trailing overview link', () => {
  const blocks = buildHubLauncherBlocks({
    latestByType: {
      'VP Weekly': { runDate: '2026-06-29', status: 'OK', artifactUrl: 'https://x/y' },
      'Team Dashboard': null, // no runs yet
    },
    childPages: CHILD,
    hubId: '38f76fd7ac8280478e50dd2956ba6e8a',
    overviewViewId: '39576fd7-ac82-81d6-be38-000ce9bbd794',
    types: ['VP Weekly', 'Team Dashboard'],
    now: HUB_NOW,
  });
  const table = findTable(blocks);
  assert.ok(table, 'has a table block');
  assert.equal(table.table.table_width, 7);
  assert.equal(table.table.has_column_header, true);
  // header + 2 type rows
  assert.equal(table.table.children.length, 3);
  assert.deepEqual(
    table.table.children[0].table_row.cells.map((c) => flat(c)),
    ['Report', 'Status', 'Run date', 'Artifact', 'Next expected', 'Log', 'Watchdog'],
  );

  // VP Weekly row: name cell links to the child page url; status + date; http artifact link
  const vp = table.table.children[1].table_row.cells;
  assert.equal(vp[0][0].text.link.url, notionPageUrl(CHILD['VP Weekly']));
  assert.equal(flat(vp[0]), 'VP Weekly');
  assert.match(flat(vp[1]), /OK/);
  assert.match(flat(vp[2]), /2026-06-29/);
  assert.equal(vp[3][0].text.link.url, 'https://x/y');
  assert.match(flat(vp[4]), /^2026-W\d{2} \(by 2026-07-\d{2}\)$/); // next expected
  assert.notEqual(flat(vp[5]), '—'); // log hint present for a scheduled type
  assert.equal(flat(vp[6]), 'stale'); // present row from 2026-06-29 is > 48h old at HUB_NOW

  // Team Dashboard row (no runs): status + date show "no data", but the Artifact cell
  // is NEVER blank (WS2) — it deep-links the child page ("page") even with no run.
  const td = table.table.children[2].table_row.cells;
  assert.equal(flat(td[0]), 'Team Dashboard');
  assert.equal(flat(td[1]), '—');
  assert.equal(flat(td[2]), '—');
  assert.equal(flat(td[3]), 'page');
  assert.equal(td[3][0].text.link.url, notionPageUrl(CHILD['Team Dashboard']));
  assert.equal(flat(td[6]), 'no runs');

  // trailing overview link paragraph
  const para = blocks.find((b) => b.type === 'paragraph');
  assert.ok(para, 'trailing overview paragraph');
  const link = para.paragraph.rich_text.find((s) => s.text?.link);
  assert.match(link.text.link.url, /#39576fd7ac8281d6be38000ce9bbd794$/);
});

test('buildHubLauncherBlocks: a non-http artifact falls back to the child-page link (never a bare path, never blank)', () => {
  const SI_PAGE = '39576fd7-ac82-8139-8438-ed06fdedebb7';
  const blocks = buildHubLauncherBlocks({
    latestByType: { 'Self-Improvement': { runDate: '2026-07-05', status: 'OK', artifactUrl: 'docs/x.md' } },
    childPages: { 'Self-Improvement': SI_PAGE },
    types: ['Self-Improvement'],
    now: HUB_NOW,
  });
  const cells = findTable(blocks).table.children[1].table_row.cells;
  // NOT the broken local path, NOT blank — a working http link to the Notion child page.
  assert.equal(flat(cells[3]), 'page');
  assert.equal(cells[3][0].text.link.url, notionPageUrl(SI_PAGE));
});

test('buildHubLauncherBlocks: artCell degrades to a dash only when the type has NO child page', () => {
  const blocks = buildHubLauncherBlocks({
    latestByType: { 'Orphan': { runDate: '2026-07-05', status: 'OK', artifactUrl: 'docs/x.md' } },
    childPages: {}, // no child page for this type
    types: ['Orphan'],
    now: HUB_NOW,
  });
  const cells = findTable(blocks).table.children[1].table_row.cells;
  assert.equal(cells[3][0].text?.link, undefined);
  assert.equal(flat(cells[3]), '—');
});

test('buildHubLauncherBlocks: a watchdog miss-row summary yields verdict "missing"', () => {
  const blocks = buildHubLauncherBlocks({
    latestByType: {
      'VP Weekly': {
        runDate: HUB_NOW.toISOString(), status: 'Failed', summary: 'watchdog: no "VP Weekly" row found for period 2026-W29 by its deadline+grace',
      },
    },
    childPages: CHILD,
    types: ['VP Weekly'],
    now: HUB_NOW,
  });
  const cells = findTable(blocks).table.children[1].table_row.cells;
  assert.equal(flat(cells[6]), 'missing');
});

test('buildHubLauncherBlocks: a fresh recent row yields verdict "present"', () => {
  const blocks = buildHubLauncherBlocks({
    latestByType: { 'VP Weekly': { runDate: HUB_NOW.toISOString(), status: 'OK', summary: 'ok' } },
    childPages: CHILD,
    types: ['VP Weekly'],
    now: HUB_NOW,
  });
  const cells = findTable(blocks).table.children[1].table_row.cells;
  assert.equal(flat(cells[6]), 'present');
});

// --- period-precise watchdogVerdict (WS1: no flat-48h stale on healthy weeklies) ---

test('watchdogVerdict: a WEEKLY type between runs reads "present" (period-precise, not flat-48h stale)', () => {
  // Tuesday 2026-07-21, 5 days after the last scheduled Thursday (2026-07-16) run.
  // A flat 48h threshold would call this stale; period-precise says the last expected
  // Thursday period IS covered -> present.
  const now = new Date(2026, 6, 21, 10, 0, 0);
  const run = { runDate: '2026-07-16', status: 'OK', summary: 'sponsor update 2026-07-16' };
  assert.equal(watchdogVerdict('FourthOS Sponsor', run, { now }), 'present');
});

test('watchdogVerdict: a genuinely-missed WEEKLY (no row for the last expected period) reads "stale"', () => {
  // Same Tuesday; the last expected period is Thursday 2026-07-16, but the newest row
  // is from the PRIOR Thursday (2026-07-09) -> the expected period was missed -> stale.
  const now = new Date(2026, 6, 21, 10, 0, 0);
  const run = { runDate: '2026-07-09', status: 'OK', summary: 'sponsor update 2026-07-09' };
  assert.equal(watchdogVerdict('FourthOS Sponsor', run, { now }), 'stale');
});

test('watchdogVerdict: a watchdog: miss-row (even with today\'s date) reads "missing"', () => {
  const now = new Date(2026, 6, 21, 10, 0, 0);
  const run = { runDate: now.toISOString(), status: 'Failed', summary: 'watchdog: no "FourthOS Sponsor" row found for period 2026-07-16 by its deadline+grace' };
  assert.equal(watchdogVerdict('FourthOS Sponsor', run, { now }), 'missing');
});

test('buildHubLauncherBlocks: an unscheduled type degrades to dashes/unscheduled instead of throwing', () => {
  const blocks = buildHubLauncherBlocks({
    latestByType: { 'Not A Real Type': { runDate: HUB_NOW.toISOString(), status: 'OK' } },
    childPages: { 'Not A Real Type': 'x' },
    types: ['Not A Real Type'],
    now: HUB_NOW,
  });
  const cells = findTable(blocks).table.children[1].table_row.cells;
  assert.equal(flat(cells[4]), '—'); // next expected
  assert.equal(flat(cells[6]), 'unscheduled');
});

test('buildHubLauncherBlocks: appends the trust rollup when trustSummary is supplied; omits it when null', () => {
  const trustSummary = {
    lookbackWeeks: 1,
    weeks: [{ week: '2026-W29', expected: 1, landed: 1, gap: 0 }],
    silentMissCount: 0,
    meanTimeToDetectionHours: null,
    ttdSampleCount: 0,
    correctiveRowRate: 0,
    correctiveRowCount: 0,
    totalRowsInWindow: 1,
  };
  const withSummary = buildHubLauncherBlocks({
    latestByType: {}, childPages: CHILD, types: ['VP Weekly'], now: HUB_NOW, trustSummary,
  });
  assert.ok(withSummary.some((b) => b.type === 'paragraph' && flat(b.paragraph.rich_text).includes('Trust metrics')));

  const withoutSummary = buildHubLauncherBlocks({
    latestByType: {}, childPages: CHILD, types: ['VP Weekly'], now: HUB_NOW,
  });
  assert.equal(withoutSummary.some((b) => b.type === 'paragraph' && flat(b.paragraph.rich_text).includes('Trust metrics')), false);
});

// --- orchestration (mocked transport) ------------------------------------------

// hubLockAcquired=false simulates the bounded-wait timing out on a live holder
// (refreshHub then proceeds WITHOUT the lock and releases nothing).
function mockDeps({ rowsByType = {}, failWriteFor = null, hubHasSection = false, hubLockAcquired = true } = {}) {
  const calls = {
    query: [], replaceSection: [], insertAfter: [], getBlocks: 0,
    acquireHubLock: 0, releaseHubLock: 0,
  };
  return {
    calls,
    query: (dsId, opts) => {
      calls.query.push({ dsId, opts });
      const type = opts?.filter?.select?.equals;
      return rowsByType[type] || [];
    },
    replaceSection: (pageId, heading, blocks) => {
      calls.replaceSection.push({ pageId, heading, blocks });
      if (failWriteFor && pageId === failWriteFor) throw new Error('simulated write failure');
    },
    getBlocks: () => {
      calls.getBlocks += 1;
      // heading at index 1; a preceding block at index 0 to anchor the insert
      return hubHasSection
        ? [{ id: 'b0', type: 'divider' }, { id: 'h', type: 'heading_2', heading_2: { rich_text: [{ plain_text: '🗂 Report pages' }] } }]
        : [{ id: 'b0', type: 'divider' }, { id: 'h1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: '🎯 Portfolio Cockpit' }] } }];
    },
    findSection: (blocks, heading) => {
      // reuse real semantics minimally: match by heading text
      const wanted = heading.replace(/^#+\s*/, '').trim();
      const idx = blocks.findIndex((b) => /heading_/.test(b.type) && (b[b.type].rich_text || []).map((t) => t.plain_text).join('').trim() === wanted);
      return idx === -1 ? null : { headingIndex: idx, start: idx + 1, end: blocks.length, blocks: [] };
    },
    insertAfter: (pageId, afterId, blocks) => { calls.insertAfter.push({ pageId, afterId, blocks }); },
    // No-op hub lock so orchestration tests never touch a real .hub.lock file.
    acquireHubLock: () => {
      calls.acquireHubLock += 1;
      return { acquired: hubLockAcquired, status: hubLockAcquired ? 'acquired' : 'held', waitedMs: hubLockAcquired ? 0 : 60_000 };
    },
    releaseHubLock: () => { calls.releaseHubLock += 1; },
  };
}

test('refreshChildPage queries with the right filter/sort and splices to "## Current run"', () => {
  const d = mockDeps({ rowsByType: { 'VP Weekly': [row({ runDate: '2026-06-29', status: 'OK', summary: 's' })] } });
  const res = refreshChildPage('VP Weekly', 'page-vp', {
    query: d.query, replaceSection: d.replaceSection, dsId: 'DS',
  });
  assert.equal(res.wrote, true);
  assert.equal(res.rows, 1);
  assert.deepEqual(d.calls.query[0].opts.filter, { property: 'Report Type', select: { equals: 'VP Weekly' } });
  assert.deepEqual(d.calls.query[0].opts.sorts, [{ property: 'Run Date', direction: 'descending' }]);
  assert.equal(d.calls.replaceSection[0].pageId, 'page-vp');
  assert.equal(d.calls.replaceSection[0].heading, CURRENT_RUN_HEADING);
  assert.equal(findCallout(d.calls.replaceSection[0].blocks).callout.rich_text.length > 0, true);
});

test('refreshChildPage with 0 rows writes the "No runs recorded yet." callout', () => {
  const d = mockDeps({ rowsByType: {} });
  const res = refreshChildPage('Team Dashboard', 'page-td', { query: d.query, replaceSection: d.replaceSection });
  assert.equal(res.rows, 0);
  const c = findCallout(d.calls.replaceSection[0].blocks);
  assert.match(flat(c.callout.rich_text), /No runs recorded yet\./);
});

test('refreshChildPage --dry-run queries but never writes', () => {
  const d = mockDeps({ rowsByType: { 'VP Weekly': [row({ runDate: '2026-06-29', status: 'OK' })] } });
  const res = refreshChildPage('VP Weekly', 'page-vp', { query: d.query, replaceSection: d.replaceSection, dryRun: true });
  assert.equal(res.wrote, false);
  assert.equal(d.calls.replaceSection.length, 0);
});

test('refreshHub CREATES the section (heading + body) when absent, near the top', () => {
  const d = mockDeps({ hubHasSection: false });
  const res = refreshHub({
    latestByType: { 'VP Weekly': { runDate: '2026-06-29', status: 'OK' } },
    childPages: CHILD, types: ['VP Weekly'],
    getBlocks: d.getBlocks, findSection: d.findSection, replaceSection: d.replaceSection, insertAfter: d.insertAfter,
    acquireHubLock: d.acquireHubLock, releaseHubLock: d.releaseHubLock,
  });
  assert.equal(res.action, 'created');
  assert.equal(d.calls.insertAfter.length, 1);
  assert.equal(d.calls.replaceSection.length, 0);
  // inserted AFTER the block preceding the first heading (b0), heading first in payload
  assert.equal(d.calls.insertAfter[0].afterId, 'b0');
  assert.equal(d.calls.insertAfter[0].blocks[0].type, 'heading_2');
  assert.equal(flat(d.calls.insertAfter[0].blocks[0].heading_2.rich_text), '🗂 Report pages');
});

test('refreshHub REPLACES only the section body when it already exists (idempotent)', () => {
  const d = mockDeps({ hubHasSection: true });
  const res = refreshHub({
    latestByType: { 'VP Weekly': { runDate: '2026-06-29', status: 'OK' } },
    childPages: CHILD, types: ['VP Weekly'],
    getBlocks: d.getBlocks, findSection: d.findSection, replaceSection: d.replaceSection, insertAfter: d.insertAfter,
    acquireHubLock: d.acquireHubLock, releaseHubLock: d.releaseHubLock,
  });
  assert.equal(res.action, 'replaced');
  assert.equal(d.calls.insertAfter.length, 0);
  assert.equal(d.calls.replaceSection[0].heading, HUB_LAUNCHER_HEADING);
});

// --- shared hub-page write lock (premortem mitigation #6, W4 race) --------------

test('refreshHub acquires the hub lock, writes, then releases it (happy path)', () => {
  const d = mockDeps({ hubHasSection: true });
  const res = refreshHub({
    latestByType: { 'VP Weekly': { runDate: '2026-06-29', status: 'OK' } },
    childPages: CHILD, types: ['VP Weekly'],
    getBlocks: d.getBlocks, findSection: d.findSection, replaceSection: d.replaceSection, insertAfter: d.insertAfter,
    acquireHubLock: d.acquireHubLock, releaseHubLock: d.releaseHubLock,
  });
  assert.equal(res.wrote, true);
  assert.equal(d.calls.acquireHubLock, 1);
  assert.equal(d.calls.releaseHubLock, 1);
  // the write happened between acquire and release (release matches acquire)
  assert.equal(d.calls.replaceSection.length, 1);
});

test('refreshHub --dry-run takes NO hub lock (it writes nothing)', () => {
  const d = mockDeps({ hubHasSection: true });
  const res = refreshHub({
    latestByType: { 'VP Weekly': { runDate: '2026-06-29', status: 'OK' } },
    childPages: CHILD, types: ['VP Weekly'], dryRun: true,
    getBlocks: d.getBlocks, findSection: d.findSection, replaceSection: d.replaceSection, insertAfter: d.insertAfter,
    acquireHubLock: d.acquireHubLock, releaseHubLock: d.releaseHubLock,
  });
  assert.equal(res.action, 'dry-run');
  assert.equal(d.calls.acquireHubLock, 0);
  assert.equal(d.calls.releaseHubLock, 0);
  assert.equal(d.calls.replaceSection.length, 0);
});

test('refreshHub PROCEEDS (and releases nothing) when the bounded wait times out on a live holder', () => {
  const d = mockDeps({ hubHasSection: true, hubLockAcquired: false });
  const res = refreshHub({
    latestByType: { 'VP Weekly': { runDate: '2026-06-29', status: 'OK' } },
    childPages: CHILD, types: ['VP Weekly'],
    getBlocks: d.getBlocks, findSection: d.findSection, replaceSection: d.replaceSection, insertAfter: d.insertAfter,
    acquireHubLock: d.acquireHubLock, releaseHubLock: d.releaseHubLock,
  });
  // availability > strictness: the write still lands, and we release nothing we don't own.
  assert.equal(res.wrote, true);
  assert.equal(d.calls.acquireHubLock, 1);
  assert.equal(d.calls.releaseHubLock, 0);
  assert.equal(d.calls.replaceSection.length, 1);
});

test('refreshHub releases the hub lock even when the write throws', () => {
  const d = mockDeps({ hubHasSection: true });
  const boom = () => { throw new Error('simulated hub write failure'); };
  assert.throws(() => refreshHub({
    latestByType: { 'VP Weekly': { runDate: '2026-06-29', status: 'OK' } },
    childPages: CHILD, types: ['VP Weekly'],
    getBlocks: d.getBlocks, findSection: d.findSection, replaceSection: boom, insertAfter: d.insertAfter,
    acquireHubLock: d.acquireHubLock, releaseHubLock: d.releaseHubLock,
  }), /simulated hub write failure/);
  assert.equal(d.calls.acquireHubLock, 1);
  assert.equal(d.calls.releaseHubLock, 1); // finally released despite the throw
});

test('refreshAll threads the hub lock through to refreshHub (acquired + released once)', () => {
  const d = mockDeps({
    rowsByType: { 'VP Weekly': [row({ runDate: '2026-06-29', status: 'OK' })] },
    hubHasSection: true,
  });
  refreshAll({
    deps: {
      query: d.query, replaceSection: d.replaceSection,
      getBlocks: d.getBlocks, findSection: d.findSection, insertAfter: d.insertAfter,
      acquireHubLock: d.acquireHubLock, releaseHubLock: d.releaseHubLock,
    },
  });
  assert.equal(d.calls.acquireHubLock, 1);
  assert.equal(d.calls.releaseHubLock, 1);
});

test('refreshAll is non-fatal per page: one child write failing still writes the others + the hub', () => {
  const d = mockDeps({
    rowsByType: {
      'VP Weekly': [row({ runDate: '2026-06-29', status: 'OK' })],
      'Self-Improvement': [row({ runDate: '2026-07-05', status: 'OK' })],
    },
    failWriteFor: '39576fd7-ac82-817d-9658-d2c8b7f84ad2', // VP Weekly child id
    hubHasSection: true,
  });
  const res = refreshAll({
    deps: {
      query: d.query, replaceSection: d.replaceSection,
      getBlocks: d.getBlocks, findSection: d.findSection, insertAfter: d.insertAfter,
      acquireHubLock: d.acquireHubLock, releaseHubLock: d.releaseHubLock,
    },
  });
  // VP Weekly recorded an error but the run kept going; the hub still refreshed.
  assert.ok(res.errors.some((e) => /VP Weekly/.test(e.scope)));
  assert.ok(res.hub, 'hub still refreshed after a child failure');
  assert.equal(res.hub.action, 'replaced');
  // every type was queried (all 6)
  assert.equal(d.calls.query.length, 6);
});

// --- scoped refresh (optimization 02: --type) ------------------------------------

test('refreshAll onlyType writes ONLY that type\'s child page, still queries all types, still refreshes the hub', () => {
  const d = mockDeps({
    rowsByType: { 'VP Weekly': [row({ runDate: '2026-06-29', status: 'OK' })] },
    hubHasSection: true,
  });
  const res = refreshAll({
    onlyType: 'VP Weekly',
    deps: {
      query: d.query, replaceSection: d.replaceSection,
      getBlocks: d.getBlocks, findSection: d.findSection, insertAfter: d.insertAfter,
      acquireHubLock: d.acquireHubLock, releaseHubLock: d.releaseHubLock,
    },
  });
  // all 6 types still queried (the hub table needs every type's latest row)
  assert.equal(d.calls.query.length, 6);
  // exactly two section writes: the scoped child page + the hub launcher body
  assert.equal(d.calls.replaceSection.length, 2);
  const childWrite = d.calls.replaceSection.find((c) => c.heading === CURRENT_RUN_HEADING);
  assert.equal(childWrite.pageId, REPORT_CHILD_PAGES['VP Weekly']);
  assert.ok(d.calls.replaceSection.some((c) => c.heading === HUB_LAUNCHER_HEADING));
  // the other 5 children are recorded as scoped skips, not silent omissions
  const skipped = res.children.filter((c) => c.skipped === 'scoped');
  assert.equal(skipped.length, 5);
  assert.equal(res.children.filter((c) => c.wrote).length, 1);
  assert.equal(res.hub.action, 'replaced');
});

test('refreshAll onlyType rejects an unknown report type (fail loud)', () => {
  assert.throws(() => refreshAll({ onlyType: 'Nonsense Type', deps: {} }), /unknown --type/);
});

test('parseTypeArg: space form, = form, absent, and missing value', () => {
  assert.equal(parseTypeArg(['--type', 'VP Weekly']), 'VP Weekly');
  assert.equal(parseTypeArg(['--type=Team Dashboard']), 'Team Dashboard');
  assert.equal(parseTypeArg(['--dry-run']), null);
  assert.throws(() => parseTypeArg(['--type']), /--type requires/);
  assert.throws(() => parseTypeArg(['--type', '--dry-run']), /--type requires/);
});
