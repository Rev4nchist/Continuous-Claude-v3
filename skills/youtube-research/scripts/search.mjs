#!/usr/bin/env node
// search.mjs — regex sweep across the corpus that returns CITATIONS, not files.
//
//   node scripts/search.mjs <pattern> [options]
//
//   --channel SLUG   restrict to one channel dir
//   --limit N        max hits (default 60)
//   --context N      also print N chunks either side of each hit
//   --case           case-sensitive (default: insensitive)
//   --json           machine-readable output
//
// This is the retrieval half of a deep-dive. Each hit carries video id, exact
// timestamp, and a clickable deep link, so a synthesis step can quote the corpus
// and every claim is verifiable by construction rather than by trust.
import { searchCorpus, listVideoFiles, readVideoDoc } from './lib/corpus.mjs';
import { citationUrl } from './lib/config.mjs';

function parseArgs(argv) {
  const o = { pattern: null, channel: null, limit: 60, context: 0, json: false, caseSensitive: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--channel') { o.channel = argv[++i]; continue; }
    if (a === '--limit') { o.limit = Number(argv[++i]); continue; }
    if (a === '--context') { o.context = Number(argv[++i]); continue; }
    if (a === '--case') { o.caseSensitive = true; continue; }
    if (a === '--json') { o.json = true; continue; }
    if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    if (!o.pattern) o.pattern = a;
    else throw new Error(`Unexpected extra argument: ${a}`);
  }
  if (!o.pattern) throw new Error('Usage: search.mjs <pattern> [--channel SLUG] [--limit N] [--context N] [--json]');
  return o;
}

// Pull surrounding transcript chunks for a hit, so a quote can be read in
// context before it is used in a digest.
function contextFor(hit, n) {
  for (const file of listVideoFiles(hit.channel)) {
    const { meta, body } = readVideoDoc(file);
    if (meta.video_id !== hit.videoId) continue;

    const lines = body
      .slice(body.indexOf('## Transcript'))
      .split('\n')
      .filter((l) => /^\[\d+:\d{2}/.test(l));
    const idx = lines.findIndex((l) => l.startsWith(`[${hit.timestamp}]`));
    if (idx === -1) return [];
    return lines.slice(Math.max(0, idx - n), idx + n + 1);
  }
  return [];
}

function main() {
  const o = parseArgs(process.argv.slice(2));

  let hits;
  try {
    hits = searchCorpus(o.pattern, {
      channel: o.channel,
      flags: o.caseSensitive ? 'g' : 'ig',
      limit: o.limit,
    });
  } catch (e) {
    throw new Error(`Bad pattern /${o.pattern}/: ${e.message}`);
  }

  if (o.json) {
    const withCtx = o.context > 0
      ? hits.map((h) => ({ ...h, context: contextFor(h, o.context) }))
      : hits;
    console.log(JSON.stringify({ pattern: o.pattern, count: hits.length, hits: withCtx }, null, 2));
    return;
  }

  if (hits.length === 0) {
    console.log(`No matches for /${o.pattern}/${o.channel ? ` in ${o.channel}` : ''}.`);
    return;
  }

  // Group by video so a reader sees "this idea recurs across N videos", which is
  // the signal that matters when deciding what a channel actually argues.
  const byVideo = new Map();
  for (const h of hits) {
    if (!byVideo.has(h.videoId)) byVideo.set(h.videoId, []);
    byVideo.get(h.videoId).push(h);
  }

  console.log(`${hits.length} hit(s) for /${o.pattern}/ across ${byVideo.size} video(s)\n`);

  for (const [videoId, group] of byVideo) {
    const g = group[0];
    console.log(`${g.channelName} — ${g.title} (${g.uploadDate})  [${group.length} hit(s)]`);
    for (const h of group) {
      console.log(`  [${h.timestamp}] ${h.text.slice(0, 160)}`);
      console.log(`           ${citationUrl(videoId, h.seconds)}`);
      if (o.context > 0) {
        for (const line of contextFor(h, o.context)) console.log(`      | ${line.slice(0, 170)}`);
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
