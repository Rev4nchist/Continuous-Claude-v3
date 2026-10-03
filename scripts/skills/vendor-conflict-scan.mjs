#!/usr/bin/env node
// Conflict scan for a vendored skill source: lists every line that conflicts with a CCv3 "never"
// rule, and fails when an overlay entry does not cover one. Read-only: it never writes in the source.
//
// Usage: node scripts/skills/vendor-conflict-scan.mjs --source <dir> [--overlay <file>] [--json] [--uncovered]
//   --source   a vendor source root: .claude/skills/_vendor/<source>, or an upstream clone
//   --overlay  overlay file (default <source>/overlay.json). Format and seeds: lib/conflict-scan.mjs
//   --uncovered  list only the uncovered hits
// Exit 1 when any hit is uncovered, the overlay is malformed or has an entry over its limits, or no file was scanned.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, formatHits } from './lib/conflict-scan.mjs';

export function main(argv) {
  const has = (k) => argv.includes(k);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const source = val('--source');
  if (!source) { console.error('vendor-conflict-scan: --source <dir> is required'); return 2; }
  const res = scanSource(path.resolve(source), { overlayFile: val('--overlay') ? path.resolve(val('--overlay')) : undefined });
  const problems = [...res.overlayErrors, ...res.entryViolations];
  const failed = res.uncovered.length > 0 || problems.length > 0 || res.files === 0;
  if (has('--json')) {
    console.log(JSON.stringify({ source: path.resolve(source), files: res.files, hits: res.hits, uncovered: res.uncovered.length, overlayErrors: res.overlayErrors, entryViolations: res.entryViolations, entries: res.entryStats, unusedEntries: res.unusedEntries }, null, 1));
    return failed ? 1 : 0;
  }
  for (const l of formatHits(res, { all: !has('--uncovered') })) console.log(l);
  for (const e of res.overlayErrors) console.log(`OVERLAY ERROR ${e}`);
  for (const e of res.entryStats) console.log(`overlay [${e.topic}] /${e.pattern}/: ${e.hits} hits in ${e.fileCount} files (cap ${e.max_hits})`);
  for (const v of res.entryViolations) console.log(`OVERLAY ENTRY ${v}`);
  for (const u of res.unusedEntries) console.log(`note: overlay entry matches no hit: ${u}`);
  const byTopic = {};
  for (const h of res.hits) byTopic[h.topic] = (byTopic[h.topic] || 0) + 1;
  console.log(`hits by topic: ${Object.entries(byTopic).map(([t, c]) => `${t}=${c}`).join(' ') || 'none'}`);
  console.log(`vendor-conflict-scan: scanned ${res.files} files, ${res.hits.length} hits, ${res.uncovered.length} uncovered, ${problems.length} overlay errors`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
