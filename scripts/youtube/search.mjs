#!/usr/bin/env node
// search.mjs — regex sweep across the corpus that returns CITATIONS WITH THEIR
// SURROUNDING TEXT, so a caller can quote the corpus without opening a file.
//
//   node scripts/youtube/search.mjs <pattern> [options]
//
//   --channel SLUG   restrict to one channel dir
//   --project ID     restrict to videos tagged with this project
//   --window N       chunks of context either side of a hit (default 2, 0 = hit only)
//   --limit N        max hits (default 40)
//   --case           case-sensitive (default: insensitive)
//   --files          print matching file paths only (for the rare full-read case)
//   --json           machine-readable output
//
// SI-02: this used to return a filename and leave the caller to read the file.
// Measured cost of that: ~4,300 tokens for a median transcript, ~25,000 for the
// largest, versus ~300 for the ±2 window that actually contains the cited claim
// (14x / 83x amplification). The window is now the default return value.
//
// `--files` remains for the genuine full-read case — but reach for `--window 6`
// first; widening a window is almost always cheaper than opening a transcript.
import { searchCorpus } from './lib/corpus.mjs';

function parseArgs(argv) {
  const o = {
    pattern: null, channel: null, project: null,
    window: 2, limit: 40, json: false, caseSensitive: false, filesOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--channel') { o.channel = argv[++i]; continue; }
    if (a === '--project') { o.project = argv[++i]; continue; }
    if (a === '--window') { o.window = Number(argv[++i]); continue; }
    if (a === '--limit') { o.limit = Number(argv[++i]); continue; }
    if (a === '--case') { o.caseSensitive = true; continue; }
    if (a === '--files') { o.filesOnly = true; continue; }
    if (a === '--json') { o.json = true; continue; }
    // Back-compat: --context was the old flag name for the same idea.
    if (a === '--context') { o.window = Number(argv[++i]); continue; }
    if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    if (!o.pattern) o.pattern = a;
    else throw new Error(`Unexpected extra argument: ${a}`);
  }
  if (!o.pattern) {
    throw new Error('Usage: search.mjs <pattern> [--channel SLUG] [--project ID] [--window N] [--limit N] [--json]');
  }
  if (!Number.isFinite(o.window) || o.window < 0) throw new Error('--window must be >= 0');
  return o;
}

// Rough token estimate so the caller can see what retrieval actually cost.
const estTokens = (s) => Math.ceil(s.length / 4);

function main() {
  const o = parseArgs(process.argv.slice(2));

  let hits;
  try {
    hits = searchCorpus(o.pattern, {
      channel: o.channel,
      project: o.project,
      flags: o.caseSensitive ? 'g' : 'ig',
      limit: o.limit,
      window: o.window,
    });
  } catch (e) {
    throw new Error(`Bad pattern /${o.pattern}/: ${e.message}`);
  }

  if (o.json) {
    console.log(JSON.stringify({
      pattern: o.pattern,
      window: o.window,
      count: hits.length,
      estTokens: hits.reduce((n, h) => n + estTokens(h.windowText), 0),
      hits,
    }, null, 2));
    return;
  }

  if (hits.length === 0) {
    const scope = [o.channel && `channel ${o.channel}`, o.project && `project ${o.project}`]
      .filter(Boolean).join(', ');
    console.log(`No matches for /${o.pattern}/${scope ? ` in ${scope}` : ''}.`);
    return;
  }

  if (o.filesOnly) {
    for (const f of [...new Set(hits.map((h) => h.file))]) console.log(f);
    return;
  }

  // Group by video so "this idea recurs across N videos" is visible — the signal
  // that matters when deciding what a channel actually argues.
  const byVideo = new Map();
  for (const h of hits) {
    if (!byVideo.has(h.videoId)) byVideo.set(h.videoId, []);
    byVideo.get(h.videoId).push(h);
  }

  const totalTokens = hits.reduce((n, h) => n + estTokens(h.windowText), 0);
  console.log(
    `${hits.length} window(s) across ${byVideo.size} video(s) for /${o.pattern}/ `
    + `· ±${o.window} chunks · ~${totalTokens} tokens returned\n`,
  );

  for (const [videoId, group] of byVideo) {
    const g = group[0];
    const asr = g.transcriptSource === 'auto' ? ' [ASR]' : '';
    console.log(`${g.channelName} — ${g.title} (${g.uploadDate})${asr}  [${group.length} window(s)]`);
    for (const h of group) {
      const span = h.windowFrom === h.windowTo ? h.windowFrom : `${h.windowFrom}–${h.windowTo}`;
      const more = h.matchCount > 1 ? ` (${h.matchCount} matches merged)` : '';
      console.log(`\n  @${h.timestamp}  ${h.url}${more}`);
      console.log(`  window ${span}:`);
      for (const c of h.window) {
        const marker = c.timestamp === h.timestamp ? '>' : ' ';
        console.log(`  ${marker} [${c.timestamp}] ${c.text}`);
      }
    }
    console.log('');
  }
}

try {
  main();
} catch (e) {
  console.error(`search failed: ${e.message}`);
  process.exit(1);
}
