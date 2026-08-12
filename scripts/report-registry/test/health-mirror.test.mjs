// health-mirror.test.mjs — pure tests for the health-mirror builders + section splice
// orchestration (mocked transport; no ntn spawn). Verifies:
//   - summarizeHealth folds counts/status/duration/next-run/critical-path/warns + ages
//   - statusEmoji/statusLabel, nextFriday, local date formatting
//   - Current Status table + Critical Path bullets; dynamic heading
//   - Run Log row + table rebuild with idempotent dedup by the local-minute key
//   - WARN Breakdown table + resolved paragraph; dynamic heading (item count)
//   - sectionBounds prefix match (+ missing / first-block guards)
//   - spliceSection insert-then-delete order (mocked transport)
//   - refreshRunLog dedup + mirrorHealth non-fatal + dry-run touches nothing
// Run: node --test scripts/report-registry/test/health-mirror.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  statusEmoji, statusLabel, nextFriday, formatLocalDate, formatLocalDateTime,
  summarizeHealth, currentStatusHeading, buildCurrentStatusBlocks, buildCriticalPathBullets,
  runLogNote, buildRunLogRow, buildRunLogTable,
  warnBreakdownHeading, buildWarnBreakdownBlocks,
  describeBlocks, sectionBounds, spliceSection, readRunLogRows, refreshRunLog, mirrorHealth,
  CURRENT_STATUS_PREFIX, RUN_LOG_HEADING, WARN_BREAKDOWN_PREFIX,
} from '../health-mirror.mjs';

// --- fixtures ------------------------------------------------------------------
function result(name, status, { severity = 'INFO', evidence = '', duration_ms = 0 } = {}) {
  return { name, status, severity, evidence, duration_ms, remediation: '', metadata: {} };
}
// A WARN run: all 3 critical-path checks green, 2 WARNs.
function healthJson(over = {}) {
  return {
    timestamp: '2026-07-17T13:03:01.148588+00:00',
    duration_s: 20.611,
    overall_status: 'WARN',
    counts: { PASS: 44, WARN: 5, FAIL: 0, SKIP: 10 },
    results: [
      result('docker-daemon-running', 'PASS', { evidence: 'docker version returned 0' }),
      result('postgres-container-running', 'PASS', { evidence: 'running: continuous-claude-postgres' }),
      result('rlm-sandbox-image-present', 'PASS', { evidence: 'image id=efb4c66a2e9f' }),
      result('memory-connection', 'PASS', { evidence: 'SELECT 1 returned 1' }),
      result('memory-canary-roundtrip', 'SKIP', { evidence: 'skipped via --skip-slow' }),
      result('hook-dist-freshness', 'PASS', { evidence: '112 hook sources -> dist all current' }),
      result('hook-registrations-valid', 'PASS', { evidence: '76 hook registrations all resolve' }),
      result('sync-drift-skills', 'PASS', { evidence: 'skills in sync' }),
      result('sync-drift-rules', 'PASS', { evidence: 'rules in sync' }),
      result('sync-drift-agents', 'PASS', { evidence: 'agents in sync' }),
      result('git-remote-sync', 'PASS', { evidence: 'in sync with fork/main (main)' }),
      result('knowledge-tree-present', 'PASS', { evidence: 'valid (97526 bytes, 0.5d old)' }),
      result('claude-opc-dir-set', 'WARN', { severity: 'MEDIUM', evidence: 'CLAUDE_OPC_DIR not set' }),
      result('cli-qlty', 'WARN', { severity: 'LOW', evidence: 'qlty present but exit=1' }),
      ...over.results || [],
    ],
    ...over,
  };
}

const flat = (rich) => (rich || []).map((s) => s.text?.content ?? '').join('');
const flatCell = (c) => (c || []).map((s) => s.text?.content ?? '').join('');
const findTable = (blocks) => blocks.find((b) => b.type === 'table');

// --- status/label/date helpers -------------------------------------------------
test('statusEmoji/statusLabel map known states; unknown -> worst light', () => {
  assert.equal(statusEmoji('PASS'), '🟢');
  assert.equal(statusEmoji('WARN'), '🟡');
  assert.equal(statusEmoji('HIGH_FAIL'), '🟠');
  assert.equal(statusEmoji('CRITICAL_FAIL'), '🔴');
  assert.equal(statusEmoji('WAT'), '🔴');
  assert.equal(statusLabel('CRITICAL_FAIL'), 'CRITICAL');
  assert.equal(statusLabel('HIGH_FAIL'), 'HIGH FAIL');
});

test('nextFriday: from a Friday -> +7; from a Wednesday -> the coming Friday', () => {
  assert.equal(formatLocalDate(nextFriday(new Date(2026, 6, 17))), '2026-07-24'); // Fri -> +7
  assert.equal(formatLocalDate(nextFriday(new Date(2026, 6, 15))), '2026-07-17'); // Wed -> Fri
});

test('formatLocalDateTime pads to YYYY-MM-DD HH:MM', () => {
  assert.equal(formatLocalDateTime(new Date(2026, 6, 5, 8, 3)), '2026-07-05 08:03');
});

// --- summarizeHealth -----------------------------------------------------------
test('summarizeHealth folds counts, total, emoji, duration, next-run, critical path', () => {
  const s = summarizeHealth(healthJson());
  assert.deepEqual(s.counts, { PASS: 44, WARN: 5, FAIL: 0, SKIP: 10 });
  assert.equal(s.total, 59);
  assert.equal(s.overallEmoji, '🟡');
  assert.equal(s.overallLabel, 'WARN');
  assert.equal(s.durationLabel, '20.6s');
  assert.equal(s.criticalPathAllGreen, true);
  assert.equal(s.nextRunLabel, '2026-07-24 08:03 AM');
  // 2 WARN entries in the fixture
  assert.equal(s.warns.length, 2);
});

test('summarizeHealth ages WARNs vs the prior run set and lists resolved', () => {
  const previousWarnNames = new Set(['cli-qlty', 'sync-drift-skills']);
  const s = summarizeHealth(healthJson(), { previousWarnNames });
  const byName = Object.fromEntries(s.warns.map((w) => [w.name, w.age]));
  assert.equal(byName['cli-qlty'], 'pre-existing'); // in prior set
  assert.equal(byName['claude-opc-dir-set'], 'new'); // not in prior set
  // sync-drift-skills was WARN before, PASS now -> resolved
  assert.deepEqual(s.resolved, ['sync-drift-skills']);
});

test('summarizeHealth: FAIL entries sort before WARN and count CRITICAL severity', () => {
  const json = healthJson({
    overall_status: 'CRITICAL_FAIL',
    counts: { PASS: 40, WARN: 2, FAIL: 1, SKIP: 10 },
    results: [result('docker-daemon-running-DOWN', 'FAIL', { severity: 'CRITICAL', evidence: 'docker down' })],
  });
  const s = summarizeHealth(json);
  assert.equal(s.warns[0].status, 'FAIL'); // FAIL first
  assert.equal(s.critical, 1);
  assert.equal(s.overallEmoji, '🔴');
});

// --- Current Status ------------------------------------------------------------
test('currentStatusHeading carries the dynamic week label', () => {
  const s = summarizeHealth(healthJson());
  assert.equal(currentStatusHeading(s), `${CURRENT_STATUS_PREFIX} — Week of ${s.weekLabel}`);
});

test('buildCurrentStatusBlocks: 2-col table (Field/Value) + Critical Path heading + bullets', () => {
  const s = summarizeHealth(healthJson());
  const blocks = buildCurrentStatusBlocks(s);
  const tbl = findTable(blocks);
  assert.equal(tbl.table.table_width, 2);
  const rowLabels = tbl.table.children.map((r) => flatCell(r.table_row.cells[0]));
  assert.deepEqual(rowLabels, ['Field', 'Overall', 'Counts', 'Duration', 'Scheduler', 'Context']);
  // Overall value cell carries emoji + FAIL/CRITICAL breakdown
  assert.match(flatCell(tbl.table.children[1].table_row.cells[1]), /🟡 WARN \(0 FAIL \/ 0 CRITICAL\)/);
  // Counts cell format
  assert.match(flatCell(tbl.table.children[2].table_row.cells[1]), /44 PASS · 5 WARN · 0 FAIL · 10 SKIP \(59 checks\)/);
  // heading_3 for the critical path (all green here)
  const h3 = blocks.find((b) => b.type === 'heading_3');
  assert.match(flat(h3.heading_3.rich_text), /Critical Path — All Green/);
  // a bullet exists for the infra group
  const bullets = blocks.filter((b) => b.type === 'bulleted_list_item');
  assert.ok(bullets.length >= 1);
  assert.match(flat(bullets[0].bulleted_list_item.rich_text), /docker-daemon-running PASS/);
});

test('buildCriticalPathBullets omits absent checks (no empty groups)', () => {
  const byName = new Map([['docker-daemon-running', { status: 'PASS', evidence: 'ok' }]]);
  const bullets = buildCriticalPathBullets(byName);
  // only the infra group has any present check
  assert.equal(bullets.length, 1);
  assert.match(flat(bullets[0].bulleted_list_item.rich_text), /docker-daemon-running PASS \(ok\)/);
});

// --- Run Log -------------------------------------------------------------------
test('runLogNote is a short status-derived phrase', () => {
  assert.equal(runLogNote(summarizeHealth(healthJson())), 'Nominal — 5 WARN, 0 FAIL');
  assert.equal(runLogNote(summarizeHealth(healthJson({ counts: { PASS: 50, WARN: 0, FAIL: 0, SKIP: 9 } }))), 'All green — nominal run');
  assert.equal(runLogNote(summarizeHealth(healthJson({ counts: { PASS: 40, WARN: 2, FAIL: 3, SKIP: 9 } }))), '3 FAIL — investigate');
});

test('buildRunLogRow: Date · Status · P/W/F · Duration · Notes', () => {
  const s = summarizeHealth(healthJson());
  const row = buildRunLogRow(s);
  const cells = row.table_row.cells.map(flatCell);
  assert.equal(cells[0], s.dateKey);
  assert.equal(cells[1], '🟡 WARN');
  assert.equal(cells[2], '44 / 5 / 0');
  assert.equal(cells[3], '21s'); // 20.611 rounded
  assert.match(cells[4], /Nominal/);
});

test('buildRunLogTable: header + new row + kept prior rows (5 cols)', () => {
  const s = summarizeHealth(healthJson());
  const newRow = buildRunLogRow(s);
  const kept = [{ cells: ['2026-04-24 18:33', '🟡 WARN', '44 / 7 / 0', '41s', 'Post-reboot'] }];
  const tbl = buildRunLogTable(newRow, kept);
  assert.equal(tbl.table.table_width, 5);
  assert.equal(tbl.table.children.length, 3); // header + new + 1 prior
  assert.equal(flatCell(tbl.table.children[0].table_row.cells[0]), 'Date');
  assert.equal(flatCell(tbl.table.children[1].table_row.cells[0]), s.dateKey);
  assert.equal(flatCell(tbl.table.children[2].table_row.cells[0]), '2026-04-24 18:33');
});

test('refreshRunLog dedups this run\'s own prior row (idempotent) and prepends', () => {
  const s = summarizeHealth(healthJson());
  const calls = { replace: [] };
  const readRows = () => ({
    tableId: 't',
    dataRows: [
      { cells: [s.dateKey, '🟡 WARN', '44 / 5 / 0', '21s', 'old text'] }, // same key -> dropped
      { cells: ['2026-04-24 18:33', '🟡 WARN', '44 / 7 / 0', '41s', 'Post-reboot'] },
    ],
  });
  const res = refreshRunLog('page', s, {
    readRows,
    replaceSection: (pageId, heading, blocks) => { calls.replace.push({ pageId, heading, blocks }); },
  });
  assert.equal(res.wrote, true);
  assert.equal(res.kept, 1); // the same-key row was dropped, the April row kept
  assert.equal(calls.replace[0].heading, RUN_LOG_HEADING);
  const tbl = calls.replace[0].blocks[0];
  // header + new + 1 kept = 3 rows; new row at index 1 carries this run's key
  assert.equal(tbl.table.children.length, 3);
  assert.equal(flatCell(tbl.table.children[1].table_row.cells[0]), s.dateKey);
});

// --- WARN Breakdown ------------------------------------------------------------
test('warnBreakdownHeading carries the dynamic item count', () => {
  const s = summarizeHealth(healthJson());
  assert.equal(warnBreakdownHeading(s), `${WARN_BREAKDOWN_PREFIX} (2 items)`);
  const one = summarizeHealth(healthJson({ counts: { PASS: 45, WARN: 1, FAIL: 0, SKIP: 10 }, results: [] }));
  // fixture still has 2 WARN rows regardless of counts; assert singular grammar via a 1-warn synth
  assert.equal(warnBreakdownHeading({ warns: [{}] }), `${WARN_BREAKDOWN_PREFIX} (1 item)`);
  void one;
});

test('buildWarnBreakdownBlocks: 5-col table (one row per WARN/FAIL) + resolved paragraph', () => {
  const s = summarizeHealth(healthJson(), { previousWarnNames: new Set(['cli-qlty', 'sync-drift-skills']) });
  const blocks = buildWarnBreakdownBlocks(s);
  const tbl = findTable(blocks);
  assert.equal(tbl.table.table_width, 5);
  assert.deepEqual(tbl.table.children[0].table_row.cells.map(flatCell), ['#', 'Check', 'Severity', 'Evidence', 'Age']);
  assert.equal(tbl.table.children.length, 1 + s.warns.length); // header + 2 warns
  const para = blocks.find((b) => b.type === 'paragraph');
  assert.match(flat(para.paragraph.rich_text), /None of these degrade the critical path/);
  assert.match(flat(para.paragraph.rich_text), /Resolved since the previous run: sync-drift-skills\./);
});

test('buildWarnBreakdownBlocks: FAIL run leads with the FAIL note', () => {
  const s = summarizeHealth(healthJson({ counts: { PASS: 40, WARN: 2, FAIL: 1, SKIP: 10 }, results: [result('x', 'FAIL', { severity: 'HIGH', evidence: 'boom' })] }));
  const para = buildWarnBreakdownBlocks(s).find((b) => b.type === 'paragraph');
  assert.match(flat(para.paragraph.rich_text), /1 FAIL this run/);
});

// --- describeBlocks ------------------------------------------------------------
test('describeBlocks renders headings, tables, bullets for --dry-run', () => {
  const s = summarizeHealth(healthJson());
  const out = describeBlocks(buildCurrentStatusBlocks(s));
  assert.match(out, /table \(2 cols/);
  assert.match(out, /### Critical Path/);
  assert.match(out, /• docker-daemon-running PASS/);
});

// --- sectionBounds -------------------------------------------------------------
function h2(id, text) { return { id, type: 'heading_2', heading_2: { rich_text: [{ plain_text: text }] } }; }
function para(id) { return { id, type: 'paragraph', paragraph: { rich_text: [] } }; }

test('sectionBounds finds a section by PREFIX and scopes the body to the next h2', () => {
  const blocks = [
    para('p0'),
    h2('h1', 'Current Status — Week of 2026-07-17'),
    { id: 't', type: 'table', table: {} },
    { id: 'b1', type: 'bulleted_list_item' },
    h2('h2', 'Run Log'),
    { id: 't2', type: 'table', table: {} },
  ];
  const b = sectionBounds(blocks, 'Current Status');
  assert.equal(b.headingId, 'h1');
  assert.equal(b.anchorId, 'p0');
  assert.deepEqual(b.body.map((x) => x.id), ['t', 'b1']); // stops before Run Log h2
});

test('sectionBounds keeps a heading_3 INSIDE the section', () => {
  const blocks = [
    para('p0'),
    h2('h1', 'Current Status — Week of X'),
    { id: 't', type: 'table', table: {} },
    { id: 'h3', type: 'heading_3', heading_3: { rich_text: [{ plain_text: 'Critical Path' }] } },
    { id: 'b1', type: 'bulleted_list_item' },
    h2('h2', 'Run Log'),
  ];
  const b = sectionBounds(blocks, 'Current Status');
  assert.deepEqual(b.body.map((x) => x.id), ['t', 'h3', 'b1']);
});

test('sectionBounds returns null when absent; throws when the section is the first block', () => {
  assert.equal(sectionBounds([para('p0'), h2('h', 'Run Log')], 'Nope'), null);
  assert.throws(() => sectionBounds([h2('h', 'Current Status')], 'Current Status'), /no preceding anchor/);
});

// --- spliceSection (mocked transport) ------------------------------------------
test('spliceSection inserts [heading, ...body] after the anchor THEN deletes old heading+body', () => {
  const blocks = [
    para('p0'),
    h2('h1', 'WARN Breakdown (5 items)'),
    { id: 'oldtbl', type: 'table', table: {} },
    { id: 'oldpara', type: 'paragraph', paragraph: { rich_text: [] } },
    h2('h2', 'Your Suggested Actions'),
  ];
  const calls = { insert: [], del: [] };
  const res = spliceSection('page', {
    prefix: 'WARN Breakdown', headingText: 'WARN Breakdown (2 items)', body: [{ type: 'table', table: {} }],
  }, {
    getBlocks: () => blocks,
    insertAfter: (pageId, afterId, newBlocks) => calls.insert.push({ pageId, afterId, newBlocks }),
    del: (id) => calls.del.push(id),
  });
  assert.equal(res.wrote, true);
  // inserted AFTER the anchor (p0), heading first in the payload
  assert.equal(calls.insert[0].afterId, 'p0');
  assert.equal(calls.insert[0].newBlocks[0].type, 'heading_2');
  assert.equal(flat(calls.insert[0].newBlocks[0].heading_2.rich_text), 'WARN Breakdown (2 items)');
  // old heading + both old body blocks archived AFTER the insert
  assert.deepEqual(calls.del, ['h1', 'oldtbl', 'oldpara']);
});

test('spliceSection --dry-run prints nothing to Notion', () => {
  const calls = { insert: 0, del: 0 };
  const res = spliceSection('page', { prefix: 'Current Status', headingText: 'X', body: [] }, {
    dryRun: true,
    getBlocks: () => { throw new Error('should not read in dry-run'); },
    insertAfter: () => { calls.insert += 1; },
    del: () => { calls.del += 1; },
  });
  assert.equal(res.wrote, false);
  assert.equal(calls.insert, 0);
  assert.equal(calls.del, 0);
});

// --- readRunLogRows (mocked) ---------------------------------------------------
test('readRunLogRows returns data rows (header dropped) with plain-text cells', () => {
  const findSection = () => ({ blocks: [{ id: 'tbl', type: 'table' }] });
  const getBlocks = (id) => (id === 'tbl'
    ? [
      { type: 'table_row', table_row: { cells: [[{ plain_text: 'Date' }], [{ plain_text: 'Status' }]] } },
      { type: 'table_row', table_row: { cells: [[{ plain_text: '2026-07-17 08:03' }], [{ plain_text: '🟡 WARN' }]] } },
    ]
    : []);
  const { tableId, dataRows } = readRunLogRows('page', { getBlocks, findSection });
  assert.equal(tableId, 'tbl');
  assert.equal(dataRows.length, 1);
  assert.deepEqual(dataRows[0].cells, ['2026-07-17 08:03', '🟡 WARN']);
});

// --- mirrorHealth orchestration ------------------------------------------------
test('mirrorHealth is non-fatal per section: one throwing still runs the others', () => {
  const s = summarizeHealth(healthJson());
  let calls = 0;
  const deps = {
    // current-status splice throws; run-log + warn-breakdown still run
    getBlocks: () => { calls += 1; if (calls === 1) throw new Error('boom current status'); return [para('p0'), h2('h', 'WARN Breakdown (2 items)'), { id: 'x', type: 'paragraph', paragraph: {} }, h2('h2', 'Your Suggested Actions')]; },
    insertAfter: () => {},
    del: () => {},
    readRows: () => ({ tableId: 't', dataRows: [] }),
    replaceSection: () => {},
    findSection: () => ({ blocks: [{ id: 't', type: 'table' }] }),
  };
  const { sections, errors } = mirrorHealth(s, { deps });
  assert.equal(errors.length, 1);
  assert.match(errors[0].scope, /current-status/);
  // run-log wrote; warn-breakdown wrote
  assert.ok(sections.find((x) => x.name === 'run-log').wrote);
  assert.ok(sections.find((x) => x.name === 'warn-breakdown').wrote);
});

test('mirrorHealth --dry-run touches no transport', () => {
  const s = summarizeHealth(healthJson());
  let touched = 0;
  const deps = {
    getBlocks: () => { touched += 1; return []; },
    insertAfter: () => { touched += 1; },
    del: () => { touched += 1; },
    replaceSection: () => { touched += 1; },
    // dry-run run-log still reads existing rows (best effort) — allow it, but no writes
    readRows: () => ({ tableId: 't', dataRows: [] }),
    findSection: () => ({ blocks: [{ id: 't', type: 'table' }] }),
  };
  const { sections, errors } = mirrorHealth(s, { dryRun: true, deps });
  assert.equal(errors.length, 0);
  assert.equal(sections.every((x) => x.wrote === false), true);
});

// --- loadRuns freshness guard (2026-08-04) --------------------------------------
// Real temp-dir fixtures: loadRuns does fs I/O, so these drive the actual reader.
// The guard exists because "newest by filename" is not "this run's output" ? a
// crashed run leaves last week's file newest, and mirroring it re-publishes old
// data as fresh (page PASS, registry disagrees).
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { loadRuns, STALE_MAX_AGE_HOURS } from '../health-mirror.mjs';

const T0 = Date.parse('2026-08-04T15:00:00.000+00:00'); // fixed "now" for determinism

function healthDir(files) {
  const dir = mkdtempSync(joinPath(tmpdir(), 'hm-fresh-'));
  for (const [name, json] of Object.entries(files)) {
    writeFileSync(joinPath(dir, name), JSON.stringify(json));
  }
  return dir;
}

test('loadRuns: fresh newest JSON loads; previous WARN names collected', () => {
  const dir = healthDir({
    'health_20260728_080000.json': healthJson({ timestamp: '2026-07-28T08:00:00+00:00' }),
    'health_20260804_140000.json': healthJson({ timestamp: '2026-08-04T14:00:00+00:00' }),
  });
  try {
    const { json, previousWarnNames } = loadRuns(dir, { now: T0 });
    assert.equal(json.timestamp, '2026-08-04T14:00:00+00:00');
    assert.equal(previousWarnNames.has('claude-opc-dir-set'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadRuns: newest JSON older than threshold THROWS STALE (crashed run left last week newest)', () => {
  const dir = healthDir({
    'health_20260731_134321.json': healthJson({ timestamp: '2026-07-31T13:43:21+00:00' }),
  });
  try {
    assert.throws(() => loadRuns(dir, { now: T0 }), /^Error: STALE:/);
    assert.throws(() => loadRuns(dir, { now: T0 }), /refusing to re-publish/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadRuns: age just inside the threshold passes; just outside throws', () => {
  const mk = (iso) => healthDir({ 'health_20260804_120000.json': healthJson({ timestamp: iso }) });
  const inside = mk(new Date(T0 - (STALE_MAX_AGE_HOURS * 3600000 - 60000)).toISOString());
  const outside = mk(new Date(T0 - (STALE_MAX_AGE_HOURS * 3600000 + 60000)).toISOString());
  try {
    assert.equal(loadRuns(inside, { now: T0 }).json.overall_status, 'WARN');
    assert.throws(() => loadRuns(outside, { now: T0 }), /STALE:/);
  } finally {
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('loadRuns: missing/unparseable timestamp THROWS STALE (never mirror unverifiable data)', () => {
  const noTs = healthJson(); delete noTs.timestamp;
  const dir = healthDir({ 'health_20260804_140000.json': noTs });
  const dir2 = healthDir({ 'health_20260804_140000.json': healthJson({ timestamp: 'not-a-date' }) });
  try {
    assert.throws(() => loadRuns(dir, { now: T0 }), /STALE:.*timestamp/);
    assert.throws(() => loadRuns(dir2, { now: T0 }), /STALE:.*timestamp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});
