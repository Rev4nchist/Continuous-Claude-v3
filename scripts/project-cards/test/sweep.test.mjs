// sweep.test.mjs — unit tests for the PURE pieces of the daily sweep.
// Only the isolatable helpers (host-kind classifier, hub-table builder) are
// tested here; the live spawns (refresh.mjs, claude -p, ntn) are not unit-tested.
// Run: node scripts/project-cards/test/sweep.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyHostKind, buildHubTable, markdownToBlocks,
  acquireSweepLock, releaseSweepLock,
  triageFailureReceiptLine, TRIAGE_EXIT_CODE, mapPmNoteRow,
  cockpitContentHash, cockpitEmbedIdFromUrl,
  deriveReportStatus, buildReportSummary,
  buildOverviewExamplePrompt, OVERVIEW_EXAMPLES,
  buildLockSkipReportRun,
} from '../sweep.mjs';
import { getOverviewExample, recordOverviewExample } from '../lib/state.mjs';
import { OVERVIEW_PAGE_ID, OVERVIEW_COCKPIT_HEADING, OVERVIEW_CARD_HEADING } from '../lib/config.mjs';

let pass = 0;
function test(name, fn) {
  fn();
  pass += 1;
  console.log(`  ok - ${name}`);
}

test('classifyHostKind: notion.so URL -> notion', () => {
  assert.equal(classifyHostKind('https://www.notion.so/Foo-30e76fd7ac82'), 'notion');
});

test('classifyHostKind: notion.com URL -> notion', () => {
  assert.equal(classifyHostKind('https://app.notion.com/p/39276fd7ac82'), 'notion');
});

test('classifyHostKind: github URL -> github', () => {
  assert.equal(classifyHostKind('https://github.com/example/repo'), 'github');
});

test('classifyHostKind: empty / null -> none', () => {
  assert.equal(classifyHostKind(''), 'none');
  assert.equal(classifyHostKind(null), 'none');
  assert.equal(classifyHostKind(undefined), 'none');
});

test('classifyHostKind: other URL -> none', () => {
  assert.equal(classifyHostKind('https://example.com/thing'), 'none');
});

test('buildHubTable: header + separator present', () => {
  const md = buildHubTable([]);
  assert.ok(md.startsWith('| Project | Health | Status | Card |\n| --- | --- | --- | --- |'));
});

test('buildHubTable: notion row renders Live card link to the page url', () => {
  const md = buildHubTable([
    { projectName: 'Connector Ecosystem', health: 'Green', status: 'Active',
      hostKind: 'notion', url: 'https://app.notion.com/p/abc' },
  ]);
  assert.ok(md.includes('| Connector Ecosystem | Green | Active | [Live card](https://app.notion.com/p/abc) |'));
});

test('buildHubTable: github row shows GitHub-only text', () => {
  const md = buildHubTable([
    { projectName: 'Repo Proj', health: 'Yellow', status: 'Active',
      hostKind: 'github', url: 'https://github.com/x/y' },
  ]);
  assert.ok(md.includes('| Repo Proj | Yellow | Active | GitHub-only — no Notion host page |'));
});

test('buildHubTable: none row shows Pending host page', () => {
  const md = buildHubTable([
    { projectName: 'No Host', health: '', status: 'Planning', hostKind: 'none', url: '' },
  ]);
  assert.ok(md.includes('| No Host | — | Planning | Pending host page |'));
});

test('buildHubTable: empty health/status fall back to em dash', () => {
  const md = buildHubTable([
    { projectName: 'X', health: '', status: '', hostKind: 'notion', url: 'https://notion.so/x' },
  ]);
  assert.ok(md.includes('| X | — | — | [Live card](https://notion.so/x) |'));
});

test('buildHubTable: row count matches input (header + one line per row)', () => {
  const rows = [
    { projectName: 'A', health: 'Green', status: 'Active', hostKind: 'notion', url: 'https://notion.so/a' },
    { projectName: 'B', health: 'Red', status: 'Active', hostKind: 'github', url: 'https://github.com/b/b' },
    { projectName: 'C', health: 'Green', status: 'Active', hostKind: 'none', url: '' },
  ];
  const lines = buildHubTable(rows).split('\n');
  assert.equal(lines.length, 2 + rows.length); // header + separator + 3 rows
});

// --- markdownToBlocks (AI-digest splice payload) ----------------------------

test('markdownToBlocks: "## " headings DEMOTED to heading_3 (cannot end the digest section)', () => {
  const blocks = markdownToBlocks('## Needs attention\ntext');
  assert.equal(blocks[0].type, 'heading_3');
  assert.equal(blocks[0].heading_3.rich_text[0].text.content, 'Needs attention');
});

test('markdownToBlocks: bullets -> bulleted_list_item, numbered lines stay paragraphs (rank fidelity)', () => {
  const blocks = markdownToBlocks('- ProjA — health: Green\n1. 🔴 [task] Fix thing — blocked');
  assert.equal(blocks[0].type, 'bulleted_list_item');
  assert.equal(blocks[0].bulleted_list_item.rich_text[0].text.content, 'ProjA — health: Green');
  assert.equal(blocks[1].type, 'paragraph');
  assert.ok(blocks[1].paragraph.rich_text[0].text.content.startsWith('1. '));
});

test('markdownToBlocks: blank lines skipped; italic footer kept as paragraph', () => {
  const blocks = markdownToBlocks('a\n\n\n_Updated: X by CCv3 sweep._\n');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].paragraph.rich_text[0].text.content, '_Updated: X by CCv3 sweep._');
});

test('markdownToBlocks: rich_text content truncated to 2000 chars (Notion limit)', () => {
  const blocks = markdownToBlocks(`x${'y'.repeat(3000)}`);
  assert.equal(blocks[0].paragraph.rich_text[0].text.content.length, 2000);
});

// --- single-instance sweep lock (mitigation #2) ------------------------------

const lockDir = mkdtempSync(join(tmpdir(), 'pc-lock-'));
const lockPath = join(lockDir, '.sweep.lock');

test('lock: clean acquire writes pid+ts payload; release removes it', () => {
  assert.equal(acquireSweepLock(lockPath), 'acquired');
  const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(payload.pid, process.pid);
  assert.ok(payload.ts);
  releaseSweepLock(lockPath);
  assert.ok(!existsSync(lockPath));
});

test('lock: fresh lock held by another run -> held', () => {
  writeFileSync(lockPath, JSON.stringify({ pid: 99999, ts: new Date().toISOString() }), 'utf8');
  assert.equal(acquireSweepLock(lockPath), 'held');
  releaseSweepLock(lockPath);
});

test('lock: >30min-old lock is treated as stale and replaced', () => {
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  writeFileSync(lockPath, JSON.stringify({ pid: 99999, ts: old }), 'utf8');
  assert.equal(acquireSweepLock(lockPath), 'stale-replaced');
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
  releaseSweepLock(lockPath);
});

test('lock: corrupt/unreadable lock file counts as stale', () => {
  writeFileSync(lockPath, 'not json at all', 'utf8');
  assert.equal(acquireSweepLock(lockPath), 'stale-replaced');
  releaseSweepLock(lockPath);
});

try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }

// --- triage helpers (mitigation #6/#8) --------------------------------------

test('TRIAGE_EXIT_CODE is 3 (distinct from generic failure 1 and lock-skip 0)', () => {
  assert.equal(TRIAGE_EXIT_CODE, 3);
});

test('triageFailureReceiptLine: ⚠ prefix, timestamp, message included', () => {
  const line = triageFailureReceiptLine('page read failed: boom', '2026-07-04T07:30');
  assert.equal(line, '⚠ triage FAILED 2026-07-04T07:30 — page read failed: boom');
});

test('triageFailureReceiptLine: error text capped at 60 chars with ellipsis', () => {
  const long = 'x'.repeat(200);
  const line = triageFailureReceiptLine(long, 'T');
  const msg = line.split(' — ')[1];
  assert.equal(msg.length, 60);
  assert.ok(msg.endsWith('…'));
});

test('triageFailureReceiptLine: newlines collapsed, empty -> "unknown"', () => {
  assert.ok(!/\n/.test(triageFailureReceiptLine('a\nb\r\nc', 'T')));
  assert.equal(triageFailureReceiptLine('', 'T'), '⚠ triage FAILED T — unknown');
  assert.equal(triageFailureReceiptLine(null, 'T'), '⚠ triage FAILED T — unknown');
});

test('mapPmNoteRow: maps title/status/type/capturedISO from typed properties', () => {
  const row = mapPmNoteRow({
    id: 'pg1',
    url: 'https://notion.so/pg1',
    created_time: '2026-07-01T00:00:00.000Z',
    properties: {
      Note: { type: 'title', title: [{ plain_text: 'Try the thing' }] },
      Status: { type: 'select', select: { name: 'open' } },
      Type: { type: 'select', select: { name: 'later' } },
      Captured: { type: 'created_time', created_time: '2026-07-02T00:00:00.000Z' },
    },
  });
  assert.equal(row.title, 'Try the thing');
  assert.equal(row.url, 'https://notion.so/pg1');
  assert.equal(row.status, 'open');
  assert.equal(row.type, 'later');
  assert.equal(row.capturedISO, '2026-07-02T00:00:00.000Z');
});

test('mapPmNoteRow: degrades to page created_time and empty fields, never throws', () => {
  const row = mapPmNoteRow({ id: 'pg2', created_time: '2026-06-30T00:00:00.000Z', properties: {} });
  assert.equal(row.title, '');
  assert.equal(row.capturedISO, '2026-06-30T00:00:00.000Z');
  assert.equal(row.url, 'pg2');
});

// --- cockpitContentHash (Fix 1 hash-gate) -----------------------------------
// A fresh copy each call so a mutation in one test never leaks into another.
const cockpitInputs = () => ({
  roster: [
    { name: 'Alpha', slug: 'alpha', health: 'Green' },
    { name: 'Beta', slug: 'beta', health: 'Yellow' },
  ],
  seriesBySlug: { alpha: [{ date: '2026-07-01', health: 'Green' }], beta: [] },
  lastSweepOk: true,
  rendererVersion: 1,
});

test('cockpitContentHash: deterministic — equal inputs produce equal hash', () => {
  assert.equal(cockpitContentHash(cockpitInputs()), cockpitContentHash(cockpitInputs()));
});

test('cockpitContentHash: returns a 64-char hex sha256 digest', () => {
  assert.match(cockpitContentHash(cockpitInputs()), /^[0-9a-f]{64}$/);
});

test('cockpitContentHash: changed roster health -> different hash', () => {
  const base = cockpitContentHash(cockpitInputs());
  const changed = cockpitInputs();
  changed.roster[0].health = 'Red';
  assert.notEqual(cockpitContentHash(changed), base);
});

test('cockpitContentHash: changed lastSweepOk (health signal) -> different hash', () => {
  const base = cockpitContentHash(cockpitInputs());
  const changed = cockpitInputs();
  changed.lastSweepOk = false;
  assert.notEqual(cockpitContentHash(changed), base);
});

test('cockpitContentHash: changed health series -> different hash', () => {
  const base = cockpitContentHash(cockpitInputs());
  const changed = cockpitInputs();
  changed.seriesBySlug.beta = [{ date: '2026-07-02', health: 'Red' }];
  assert.notEqual(cockpitContentHash(changed), base);
});

test('cockpitContentHash: bumped rendererVersion -> different hash (mitigation #8)', () => {
  const base = cockpitContentHash(cockpitInputs());
  const changed = cockpitInputs();
  changed.rendererVersion = 2;
  assert.notEqual(cockpitContentHash(changed), base);
});

test('cockpit gate decision: same hash -> SKIP; different hash -> PUBLISH', () => {
  // The live gate is `prev.publishedHash !== hash`; model it on the hashes.
  const publishedHash = cockpitContentHash(cockpitInputs());
  // Unchanged inputs -> hash matches publishedHash -> gate = skip.
  assert.equal(cockpitContentHash(cockpitInputs()) !== publishedHash, false, 'unchanged must SKIP');
  // Changed inputs -> hash differs -> gate = publish.
  const changed = cockpitInputs();
  changed.roster[1].health = 'Red';
  assert.equal(cockpitContentHash(changed) !== publishedHash, true, 'changed must PUBLISH');
});

// --- cockpitEmbedIdFromUrl (Fix 1 read-back — live-bug regression) -----------
// Notion returns the embed as an S3 presigned URL whose ?X-Amz signature changes
// on every read; the freshness identity must be the stable file-uuid path segment.
const S3 = (fileUuid) => `https://prod-files-secure.s3.us-west-2.amazonaws.com/`
  + `a512f781-a8e7-400d-b2e2-b76690fde865/${fileUuid}/fourthos-cockpit.html`
  + `?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAZI2LB4665PJPFKIT`;

test('cockpitEmbedIdFromUrl: extracts the file-uuid from an S3 presigned url', () => {
  assert.equal(cockpitEmbedIdFromUrl(S3('0f49d69e-833e-462e-8d5b-1858a9caaf78')),
    '0f49d69e-833e-462e-8d5b-1858a9caaf78');
});

test('cockpitEmbedIdFromUrl: presigned query is IGNORED (same file, two reads -> same id)', () => {
  const a = cockpitEmbedIdFromUrl(S3('0f49d69e-833e-462e-8d5b-1858a9caaf78'));
  const b = cockpitEmbedIdFromUrl(S3('0f49d69e-833e-462e-8d5b-1858a9caaf78') + '&X-Amz-Signature=DIFFERENT');
  assert.equal(a, b); // the whole point: a re-read must NOT look "fresh"
});

test('cockpitEmbedIdFromUrl: a republish (new attachment) changes the id', () => {
  const before = cockpitEmbedIdFromUrl(S3('0f49d69e-833e-462e-8d5b-1858a9caaf78'));
  const after = cockpitEmbedIdFromUrl(S3('11111111-2222-3333-4444-555555555555'));
  assert.notEqual(after, before);
});

test('cockpitEmbedIdFromUrl: falls back to the ntn-markdown attachment form', () => {
  assert.equal(
    cockpitEmbedIdFromUrl('file://%7B%22source%22%3A%22attachment%3A147607d1-a86e-4583-8f4d-41f88a02c11c%3Ax.html%22%7D'),
    '147607d1-a86e-4583-8f4d-41f88a02c11c');
});

test('cockpitEmbedIdFromUrl: unrecognized url -> block id fallback (never crashes)', () => {
  assert.equal(cockpitEmbedIdFromUrl('https://example.com/no-uuid', 'blk-123'), 'blk-123');
  assert.equal(cockpitEmbedIdFromUrl('', null), 'present');
});

// --- T3.1: Project Portfolio report-run derivation (registry emit contract) ---

test('deriveReportStatus: clean run -> OK', () => {
  assert.equal(deriveReportStatus({
    fatalError: null, publishFailed: [], hubRefreshed: true, cockpitPublished: true,
  }), 'OK');
});

test('deriveReportStatus: a fatal throw -> Failed (dominates everything)', () => {
  assert.equal(deriveReportStatus({
    fatalError: new Error('boom'), publishFailed: [], hubRefreshed: true, cockpitPublished: true,
  }), 'Failed');
});

test('deriveReportStatus: a failed card publish -> Warn', () => {
  assert.equal(deriveReportStatus({
    fatalError: null, publishFailed: [{ slug: 'x', reason: 'y' }],
    hubRefreshed: true, cockpitPublished: true,
  }), 'Warn');
});

test('deriveReportStatus: hub not refreshed -> Warn', () => {
  assert.equal(deriveReportStatus({
    fatalError: null, publishFailed: [], hubRefreshed: false, cockpitPublished: true,
  }), 'Warn');
});

test('deriveReportStatus: cockpit not published -> Warn', () => {
  assert.equal(deriveReportStatus({
    fatalError: null, publishFailed: [], hubRefreshed: true, cockpitPublished: false,
  }), 'Warn');
});

test('deriveReportStatus: mobile/triage degradation -> Warn', () => {
  assert.equal(deriveReportStatus({
    fatalError: null, publishFailed: [], hubRefreshed: true, cockpitPublished: true,
    mobileFailed: true,
  }), 'Warn');
  assert.equal(deriveReportStatus({
    fatalError: null, publishFailed: [], hubRefreshed: true, cockpitPublished: true,
    triageFailed: true,
  }), 'Warn');
});

test('buildReportSummary: 1-line headline with counts + ok/fail flags', () => {
  const s = buildReportSummary({
    refreshed: 8, publishedOk: ['a', 'b', 'c'], publishFailed: [{ slug: 'd' }],
    hubRefreshed: true, cockpitPublished: false,
  });
  assert.equal(s, 'cards refreshed=8 · published=3 · failed=1 · hub=ok · cockpit=fail · mobile=ok');
});

test('buildReportSummary: mobile failure is surfaced with its reason (was silently omitted)', () => {
  const s = buildReportSummary({
    refreshed: 8, publishedOk: ['a', 'b', 'c'], publishFailed: [],
    hubRefreshed: true, cockpitPublished: true,
    mobileFailed: true, mobileFailureCode: 'spawn: spawnSync claude ETIMEDOUT',
  });
  assert.equal(s, 'cards refreshed=8 · published=3 · failed=0 · hub=ok · cockpit=ok'
    + ' · mobile=fail(spawn: spawnSync claude ETIMEDOUT)');
});

test('buildReportSummary: mobile failure reason is capped + newline-collapsed', () => {
  const s = buildReportSummary({
    refreshed: 1, publishedOk: [], publishFailed: [], hubRefreshed: true, cockpitPublished: true,
    mobileFailed: true,
    mobileFailureCode: 'a very long multi\nline Notion connector error message that goes on and on and on',
  });
  const mobileSegment = s.split(' · mobile=')[1];
  assert.ok(mobileSegment.startsWith('fail('));
  assert.ok(!mobileSegment.includes('\n'));
  assert.ok(mobileSegment.length <= 'fail(…)'.length + 60);
});

test('buildReportSummary: mobile failure with no failureCode falls back to "unknown"', () => {
  const s = buildReportSummary({
    refreshed: 1, publishedOk: [], publishFailed: [], hubRefreshed: true, cockpitPublished: true,
    mobileFailed: true, mobileFailureCode: null,
  });
  assert.ok(s.endsWith('· mobile=fail(unknown)'));
});

// --- T9.3: lock-skip must record Skipped, never let the pre-emit Failed row stand ---

test('buildLockSkipReportRun: status is Skipped, not derived from (absent) outcome fields', () => {
  const r = buildLockSkipReportRun();
  assert.equal(r.status, 'Skipped');
  // Must NOT collapse to what deriveReportStatus({}) would produce (Warn, since
  // hubRefreshed/cockpitPublished are falsy on an empty fields object) -- a
  // lock-skip never attempted a sweep at all, so it must not be graded as if it did.
  assert.notEqual(r.status, deriveReportStatus({}));
});

test('buildLockSkipReportRun: summary self-explains the skip (mentions the lock)', () => {
  const r = buildLockSkipReportRun();
  assert.match(r.summary, /\.sweep\.lock/);
  assert.match(r.summary, /skip/i);
});

// --- optimization 01: overview-page example embeds -----------------------------

test('OVERVIEW_EXAMPLES defines both tracked surfaces with distinct headings + sources', () => {
  assert.deepEqual(Object.keys(OVERVIEW_EXAMPLES).sort(), ['card', 'cockpit']);
  assert.equal(OVERVIEW_EXAMPLES.cockpit.heading, OVERVIEW_COCKPIT_HEADING);
  assert.equal(OVERVIEW_EXAMPLES.card.heading, OVERVIEW_CARD_HEADING);
  assert.equal(OVERVIEW_EXAMPLES.cockpit.htmlFile, 'portfolio-cockpit.html');
  assert.equal(OVERVIEW_EXAMPLES.card.htmlFile, 'connector-ecosystem.html');
});

test('buildOverviewExamplePrompt: targets the overview page, replaces only the named section, fences the HTML', () => {
  const p = buildOverviewExamplePrompt({
    heading: OVERVIEW_COCKPIT_HEADING,
    html: '<html>X</html>',
    caption: 'Example caption; refreshed',
    asOfHuman: '16 Jul 2026',
  });
  assert.ok(p.includes(`Target Notion page id: ${OVERVIEW_PAGE_ID}`));
  assert.ok(p.includes(`titled exactly "${OVERVIEW_COCKPIT_HEADING}"`));
  assert.ok(p.includes('EXAMPLEDONE attachment=<id>'));
  assert.ok(p.includes('Example caption; refreshed 16 Jul 2026.'));
  assert.ok(p.includes('UNTRUSTED'));
  assert.ok(p.includes('--- BEGIN EXAMPLE HTML'));
  assert.ok(p.indexOf('<html>X</html>') > p.indexOf('--- BEGIN EXAMPLE HTML'));
});

test('state: getOverviewExample tolerates absence; recordOverviewExample merges per key', () => {
  const s = {};
  const fresh = getOverviewExample(s, 'cockpit');
  assert.deepEqual(fresh, {
    pageId: null, attachmentId: null, contentHash: null, publishedHash: null, lastPublished: null,
  });
  recordOverviewExample(s, 'cockpit', { pageId: 'pg', publishedHash: 'h1' });
  recordOverviewExample(s, 'card', { attachmentId: 'att' });
  assert.equal(getOverviewExample(s, 'cockpit').publishedHash, 'h1');
  assert.equal(getOverviewExample(s, 'cockpit').pageId, 'pg');
  assert.equal(getOverviewExample(s, 'card').attachmentId, 'att');
  assert.equal(getOverviewExample(s, 'card').publishedHash, null);
});

test('deriveReportStatus: overview-example degradation -> Warn', () => {
  assert.equal(deriveReportStatus({
    fatalError: null, publishFailed: [], hubRefreshed: true, cockpitPublished: true,
    overviewFailed: true,
  }), 'Warn');
});

test('buildReportSummary: bound count + overview-example failure segments (opt-01/03)', () => {
  const s = buildReportSummary({
    refreshed: 10, boundCards: 1, publishedOk: ['a'], publishFailed: [],
    hubRefreshed: true, cockpitPublished: true,
    overviewFailed: true, overviewFailureCode: 'cockpit:failed',
  });
  assert.equal(s, 'cards refreshed=10 (bound=1) · published=1 · failed=0 · hub=ok'
    + ' · cockpit=ok · mobile=ok · examples=fail(cockpit:failed)');
  // back-compat: both omitted when absent
  const legacy = buildReportSummary({
    refreshed: 8, publishedOk: [], publishFailed: [], hubRefreshed: true, cockpitPublished: true,
  });
  assert.equal(legacy, 'cards refreshed=8 · published=0 · failed=0 · hub=ok · cockpit=ok · mobile=ok');
});

console.log(`\n${pass} passed`);
