#!/usr/bin/env node
// setup-notion.mjs — one-time creation of the "YouTube Research" database.
//
//   node scripts/youtube/setup-notion.mjs            # dry run: show the plan
//   node scripts/youtube/setup-notion.mjs --confirm  # actually create it
//
// CONFIRM-GATED ON PURPOSE. Per .claude/rules/notion-cli-safety.md, creating a
// page/DB under a shared parent (the Reports hub) is a dangerous verb — it must
// never happen as an implicit side effect of some other command. The dry run
// prints exactly what will be created and where.
//
// Idempotent: if youtube-research.ids.json already has a dataSourceId, this
// refuses to create a second database. Use --force only to deliberately re-home.
import { apiPost, apiGet, readIds, writeIds, IDS_PATH } from './lib/notion.mjs';

// The Reports hub — verified parent of the sibling "Self-Improvement Research"
// page (2026-07-25), which makes it the established home for machine-generated
// research surfaces.
const REPORTS_HUB_PAGE_ID = '38f76fd7-ac82-8047-8e50-dd2956ba6e8a';

const DB_TITLE = 'YouTube Research';

// Schema. Kept deliberately small — every property must earn its place by being
// something you would actually filter or sort a research backlog on.
const PROPERTIES = {
  Title: { title: {} },
  Type: { select: { options: [
    { name: 'brief', color: 'blue' },
    { name: 'lab', color: 'purple' },
  ] } },
  Topic: { rich_text: {} },
  Channels: { rich_text: {} },
  Verdict: { select: { options: [
    { name: 'adopt', color: 'green' },
    { name: 'watch', color: 'yellow' },
    { name: 'skip', color: 'gray' },
    { name: 'n/a', color: 'default' },
  ] } },
  Status: { select: { options: [
    { name: 'draft', color: 'gray' },
    { name: 'reviewed', color: 'blue' },
    { name: 'ratified', color: 'green' },
    { name: 'dropped', color: 'red' },
  ] } },
  Videos: { number: {} },
  Citations: { number: {} },
  Date: { date: {} },
  // Idempotency key. A re-publish of the same digest updates its row instead of
  // appending a duplicate. Mirrors the Report Runs `Run ID` convention.
  'Digest ID': { rich_text: {} },
  'Corpus Path': { rich_text: {} },
};

function main() {
  const argv = process.argv.slice(2);
  const confirm = argv.includes('--confirm');
  const force = argv.includes('--force');

  const existing = readIds();
  if (existing?.dataSourceId && !force) {
    console.log('YouTube Research DB already configured:');
    console.log(`  database:    ${existing.databaseId}`);
    console.log(`  data source: ${existing.dataSourceId}`);
    console.log(`  url:         ${existing.url}`);
    console.log(`  ids file:    ${IDS_PATH}`);
    console.log('\nNothing to do. Pass --force to deliberately create a second DB.');
    return;
  }

  if (!confirm) {
    console.log('DRY RUN — nothing has been created.\n');
    console.log('Would create a Notion database:');
    console.log(`  title:  "${DB_TITLE}"`);
    console.log(`  parent: page ${REPORTS_HUB_PAGE_ID} (Reports hub)`);
    console.log(`  props:  ${Object.keys(PROPERTIES).join(', ')}`);
    console.log(`\n  ids will be written to: ${IDS_PATH}`);
    console.log('\nThis is a WRITE to a shared Notion surface.');
    console.log('Re-run with --confirm to proceed.');
    return;
  }

  // Verify the parent exists and is reachable before writing anything.
  const parent = apiGet(`v1/pages/${REPORTS_HUB_PAGE_ID}`);
  if (!parent?.id) throw new Error(`Reports hub page ${REPORTS_HUB_PAGE_ID} not reachable`);

  console.log(`Creating "${DB_TITLE}" under ${parent.url || REPORTS_HUB_PAGE_ID} ...`);

  const created = apiPost('v1/databases', {
    parent: { type: 'page_id', page_id: REPORTS_HUB_PAGE_ID },
    title: [{ type: 'text', text: { content: DB_TITLE } }],
    // 2025-09-03 API: a database owns one or more data sources; properties live
    // on the initial data source, not on the database.
    initial_data_source: { properties: PROPERTIES },
  });

  const databaseId = created.id;
  const dataSourceId = created.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error(`Database created (${databaseId}) but no data source returned: ${JSON.stringify(created).slice(0, 400)}`);
  }

  const ids = {
    _comment:
      'Canonical Notion IDs for the YouTube Research registry. Idempotency key = "Digest ID". '
      + 'Machine-owned (job-owned per notion-cli-safety.md): pipelines upsert rows; humans read views.',
    reportsHubPageId: REPORTS_HUB_PAGE_ID,
    databaseId,
    dataSourceId,
    url: created.url || `https://app.notion.com/p/${String(databaseId).replace(/-/g, '')}`,
    createdAt: new Date().toISOString(),
    properties: Object.keys(PROPERTIES),
  };

  writeIds(ids);

  console.log('\nCreated.');
  console.log(`  database:    ${databaseId}`);
  console.log(`  data source: ${dataSourceId}`);
  console.log(`  url:         ${ids.url}`);
  console.log(`  ids file:    ${IDS_PATH}`);
}

try {
  main();
} catch (e) {
  console.error(`setup-notion failed: ${e.message}`);
  process.exit(1);
}
