#!/usr/bin/env node
/**
 * tldr-read-corpus — what files do real sessions actually Read?
 *
 * The savings question cannot be answered on a corpus of "every code file on
 * disk". That corpus is dominated by third-party code (.venv, site-packages)
 * that nobody ever opens, and blocking a 5MB minified bundle no one would have
 * read is a saving of zero real tokens reported as ~100%.
 *
 * This reads the actual Claude Code session transcripts and extracts every
 * Read tool call that was actually issued, so the savings probe can replay a
 * real distribution instead of a synthetic one.
 *
 * Emits JSON: [{ path, count }] sorted by frequency.
 *
 * Usage:
 *   node scripts/hooks/tldr-read-corpus.mjs [--project <dirkey>] [--top N] [--json]
 */

import { readdirSync, createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const argv = process.argv;
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : dflt;
};
const PROJECT_KEY = arg('--project', 'C--Users-david-hayes-continuous-claude');
const TOP = parseInt(arg('--top', '0'), 10);
const JSON_OUT = argv.includes('--json');

const dir = join(homedir(), '.claude', 'projects', PROJECT_KEY);
if (!existsSync(dir)) {
  console.error(`no transcript dir: ${dir}`);
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
if (files.length === 0) {
  console.error(`no transcripts in ${dir}`);
  process.exit(2);
}

const counts = new Map();
let reads = 0;
let lines = 0;
let parseFails = 0;

// A transcript line is one JSON object. Tool calls appear as assistant
// messages whose content includes tool_use blocks. We look for tool_use with
// name === 'Read' and pull tool_input.file_path.
async function scan(file) {
  const rl = createInterface({
    input: createReadStream(join(dir, file), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    let obj;
    try { obj = JSON.parse(line); } catch { parseFails++; continue; }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      if (block?.name !== 'Read') continue;
      const p = block?.input?.file_path;
      if (!p) continue;
      // offset/limit reads bypass the enforcer by design — record them
      // separately rather than silently folding them in.
      const bypassed = Boolean(block.input.offset) ||
        (block.input.limit !== undefined && block.input.limit < 100);
      reads++;
      const key = p;
      const cur = counts.get(key) || { path: p, count: 0, bypass_offset_limit: 0 };
      cur.count++;
      if (bypassed) cur.bypass_offset_limit++;
      counts.set(key, cur);
    }
  }
}

for (const f of files) await scan(f);

let rows = [...counts.values()].sort((a, b) => b.count - a.count);
if (TOP > 0) rows = rows.slice(0, TOP);

const summary = {
  project_key: PROJECT_KEY,
  transcripts: files.length,
  lines_scanned: lines,
  parse_failures: parseFails,
  total_read_calls: reads,
  distinct_paths: counts.size,
};

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, rows }, null, 2));
  process.exit(0);
}

console.log('Real Read calls across session transcripts');
console.log('='.repeat(64));
for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(20)} ${v}`);
console.log('');
console.log('top paths:');
for (const r of rows.slice(0, 30)) {
  const bp = r.bypass_offset_limit ? `  (${r.bypass_offset_limit} offset/limit)` : '';
  console.log(`  ${String(r.count).padStart(4)}x  ${r.path}${bp}`);
}
