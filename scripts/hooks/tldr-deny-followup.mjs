#!/usr/bin/env node
/**
 * tldr-deny-followup — did the TLDR block actually SUBSTITUTE for the read, or
 * only defer it?
 *
 * A 95% "saving" is only a saving if the model accepted the structure summary
 * and moved on. If it immediately re-read the same file with offset/limit — or
 * worse, re-read it repeatedly to reconstruct what one read would have given —
 * the tokens come back, plus the summary, plus a wasted turn. Replaying the
 * hook cannot see this. Only the transcripts can.
 *
 * Method: find real tool_result blocks carrying the enforcer's deny marker,
 * then look at the SAME session's next Read calls to see whether that file was
 * re-read, and how.
 *
 * Classification per deny:
 *   SUBSTITUTED  — file never read again in that session. The saving is real.
 *   PARTIAL      — re-read with offset/limit (targeted follow-up; partial saving)
 *   DEFERRED     — re-read fully again later (saving is smaller than claimed)
 *
 * Usage: node scripts/hooks/tldr-deny-followup.mjs [--json]
 */

import { readdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const PROJECT_KEY = join(homedir(), 'continuous-claude').replace(/[^a-zA-Z0-9]/g, '-');
const JSON_OUT = process.argv.includes('--json');
const DENY_MARKER = 'TLDR Context';

const dir = join(homedir(), '.claude', 'projects', PROJECT_KEY);
if (!existsSync(dir)) { console.error(`no transcript dir: ${dir}`); process.exit(2); }

const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

function textOf(block) {
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) {
    return block.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
  }
  return '';
}

const denies = [];   // { session, seq, file }
const reads = [];    // { session, seq, path, targeted }

for (const f of files) {
  const session = f.replace(/\.jsonl$/, '');
  const rl = createInterface({
    input: createReadStream(join(dir, f), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let seq = 0;
  const pendingReadById = new Map();
  for await (const line of rl) {
    if (!line.trim()) continue;
    seq++;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type === 'tool_use' && block?.name === 'Read') {
        const p = block?.input?.file_path;
        if (!p) continue;
        const targeted = Boolean(block.input.offset) ||
          (block.input.limit !== undefined && block.input.limit < 100);
        reads.push({ session, seq, path: p, targeted });
        pendingReadById.set(block.id, p);
      }
      // A denied PreToolUse surfaces to the model as a tool_result carrying the
      // hook's permissionDecisionReason. Match on the marker, then resolve which
      // file it was via the originating tool_use id.
      if (block?.type === 'tool_result') {
        const t = textOf(block);
        if (t && t.includes(DENY_MARKER)) {
          const file = pendingReadById.get(block.tool_use_id) || null;
          denies.push({ session, seq, file });
        }
      }
    }
  }
}

// Classify each deny by what the same session did afterwards with that file.
const classified = { SUBSTITUTED: 0, PARTIAL: 0, DEFERRED: 0, UNRESOLVED: 0 };
const examples = { PARTIAL: [], DEFERRED: [] };

for (const d of denies) {
  if (!d.file) { classified.UNRESOLVED++; continue; }
  const after = reads.filter((r) => r.session === d.session && r.seq > d.seq && r.path === d.file);
  if (after.length === 0) classified.SUBSTITUTED++;
  else if (after.every((r) => r.targeted)) {
    classified.PARTIAL++;
    if (examples.PARTIAL.length < 5) examples.PARTIAL.push(`${d.file} (+${after.length} targeted)`);
  } else {
    classified.DEFERRED++;
    if (examples.DEFERRED.length < 5) examples.DEFERRED.push(`${d.file} (+${after.length} re-reads)`);
  }
}

const total = denies.length;
const summary = {
  transcripts: files.length,
  total_read_calls: reads.length,
  real_denies_observed: total,
  ...classified,
  substituted_pct: total ? +((classified.SUBSTITUTED / total) * 100).toFixed(1) : null,
};

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, examples }, null, 2));
  process.exit(0);
}

console.log('TLDR deny -> what happened next (real transcripts)');
console.log('='.repeat(64));
for (const [k, v] of Object.entries(summary)) console.log(`  ${String(k).padEnd(22)} ${v}`);
console.log('');
if (total === 0) {
  console.log('  NO REAL DENIES FOUND IN ANY TRANSCRIPT.');
  console.log('  The enforcer denies on replay but has not measurably fired in recorded history.');
  console.log('  Before concluding: confirm the deny marker string still matches the hook source.');
} else {
  console.log(`  SUBSTITUTED = saving is real. DEFERRED = tokens came back later.`);
  for (const k of ['PARTIAL', 'DEFERRED']) {
    if (examples[k].length) {
      console.log(`  ${k} examples:`);
      for (const e of examples[k]) console.log(`    ${e}`);
    }
  }
}
