#!/usr/bin/env node
/**
 * Backfill intel-bus.jsonl from existing CCv3 telemetry logs (WS-2 Phase A.2).
 *
 * Reads:
 *   .claude/logs/memory-recall.jsonl   (memory-awareness recall telemetry)
 * Maps each row to an intel-bus event tagged `backfilled: true` (design doc
 * section 13 Q15 -- backfilled rows are EXCLUDED from adoption gates) and
 * appends them to:
 *   .claude/logs/intel-bus.jsonl
 *
 * This seeds early dashboards so they are not empty before live events flow.
 *
 * Append safety mirrors shared/intel-bus.ts: one event == one line, embedded
 * newlines stripped, a 4 KB per-line cap (oversized rows are dropped, never
 * written long), and fail-open per row (a bad source line is skipped, not
 * fatal). Project-relative paths (CLAUDE_PROJECT_DIR || cwd). ASCII only.
 *
 * Usage:  node scripts/backfill-intel-bus.mjs
 * Output: prints how many rows were appended (and skipped) per source.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_LINE_BYTES = 4096;

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const logsDir = join(projectDir, '.claude', 'logs');
const outPath = join(logsDir, 'intel-bus.jsonl');

const SOURCES = [
  { file: join(logsDir, 'memory-recall.jsonl'), map: mapMemoryRecall, schema: 'memory-recall-v1' },
];

/** Strip embedded CR/LF from all string fields so one event stays one line. */
function stripNewlinesDeep(value) {
  if (typeof value === 'string') return value.replace(/[\r\n]+/g, ' ');
  if (Array.isArray(value)) return value.map(stripNewlinesDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripNewlinesDeep(v);
    return out;
  }
  return value;
}

/** Append one event as a single JSONL line, honoring the 4 KB cap. Fail-open. */
function appendEvent(event) {
  try {
    const normalized = stripNewlinesDeep({ ...event, schema_version: 1 });
    const line = JSON.stringify(normalized) + '\n';
    if (Buffer.byteLength(line, 'utf-8') > MAX_LINE_BYTES) return false; // drop oversized
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    appendFileSync(outPath, line, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** memory-recall.jsonl row -> intel-bus event. */
function mapMemoryRecall(row, schema) {
  return {
    ts: row.timestamp ?? new Date().toISOString(),
    bus_id: 'backfill-memory-recall',
    agent: row.subagent || 'main',
    facade: '/memory',
    specialist: 'archival_memory',
    query_type: 'memory_recall',
    subject_id: typeof row.intent === 'string' ? row.intent.slice(0, 200) : null,
    result_count: typeof row.results_count === 'number' ? row.results_count : null,
    rank: 1,
    top_score: typeof row.top_score === 'number' ? row.top_score : null,
    kept_after_floor: typeof row.kept_after_floor === 'number' ? row.kept_after_floor : null,
    recall_source: row.source ?? null,
    correlation_id: null,
    backfilled: true,
    source_schema: schema,
  };
}

function backfillSource({ file, map, schema }) {
  if (!existsSync(file)) {
    return { file, appended: 0, skipped: 0, missing: true };
  }
  const text = readFileSync(file, 'utf-8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  let appended = 0;
  let skipped = 0;
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      skipped++;
      continue; // skip a malformed source line, don't abort the run
    }
    if (appendEvent(map(row, schema))) appended++;
    else skipped++;
  }
  return { file, appended, skipped, missing: false };
}

function main() {
  let total = 0;
  console.log(`Backfilling intel-bus at: ${outPath}`);
  for (const src of SOURCES) {
    const r = backfillSource(src);
    if (r.missing) {
      console.log(`  ${dirname(src.file) ? '' : ''}${src.file}: MISSING (skipped)`);
      continue;
    }
    total += r.appended;
    console.log(`  ${src.file}: appended ${r.appended}, skipped ${r.skipped}`);
  }
  console.log(`Total rows appended to intel-bus.jsonl: ${total}`);
}

main();
