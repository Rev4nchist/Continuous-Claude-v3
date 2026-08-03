#!/usr/bin/env node
// status.mjs — what is in the corpus, what is subscribed, what is pending.
//
//   node scripts/status.mjs [--json]
//
// The one-screen answer to "what do I actually have to research over?".
import { existsSync, readFileSync } from 'node:fs';
import { corpusStats, dirSizeBytes, channelDir } from './lib/corpus.mjs';
import { WATCHLIST_PATH, DIGEST_INDEX, CORPUS_ROOT } from './lib/config.mjs';

function readWatchlist() {
  if (!existsSync(WATCHLIST_PATH)) return { channels: [] };
  try { return JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8')); } catch { return { channels: [] }; }
}

function countDigests() {
  if (!existsSync(DIGEST_INDEX)) return 0;
  // INDEX.md is an append-only markdown table; data rows start with "| 20".
  return readFileSync(DIGEST_INDEX, 'utf8')
    .split('\n')
    .filter((l) => /^\|\s*20\d\d-/.test(l)).length;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function main() {
  const json = process.argv.includes('--json');
  const stats = corpusStats();
  const watch = readWatchlist();
  const watched = new Set((watch.channels || []).map((c) => c.slug));

  const channels = stats.channels.map((c) => ({
    ...c,
    watched: watched.has(c.channel),
    bytes: dirSizeBytes(channelDir(c.channel)),
  }));

  const payload = {
    corpusRoot: CORPUS_ROOT,
    totalChannels: channels.length,
    totalVideos: stats.totalVideos,
    totalWords: stats.totalWords,
    digests: countDigests(),
    watchlist: watch.channels || [],
    channels,
  };

  if (json) { console.log(JSON.stringify(payload, null, 2)); return; }

  console.log(`Corpus: ${CORPUS_ROOT}`);
  console.log(`  ${payload.totalChannels} channel(s) · ${payload.totalVideos} video(s) · ${payload.totalWords.toLocaleString('en-US')} words · ${payload.digests} digest(s)\n`);

  if (channels.length === 0) {
    console.log('  (empty — run: node scripts/ingest.mjs "@channel" --limit 10)');
  } else {
    const w = Math.max(10, ...channels.map((c) => c.name.length));
    console.log(`  ${'CHANNEL'.padEnd(w)}  VIDEOS  TRANSCR  WORDS      NEWEST      SIZE    WATCHED`);
    for (const c of channels) {
      console.log(
        `  ${c.name.padEnd(w)}  ${String(c.videos).padStart(6)}  ${String(c.withTranscript).padStart(7)}  ` +
        `${c.words.toLocaleString('en-US').padStart(9)}  ${(c.newestUpload || '—').padEnd(10)}  ` +
        `${human(c.bytes).padStart(7)}  ${c.watched ? 'yes' : '—'}`,
      );
    }
  }

  const pending = (watch.channels || []).filter((c) => c.pendingDigest);
  if (pending.length) {
    console.log(`\n  ${pending.length} channel(s) have new videos awaiting a digest:`);
    for (const c of pending) console.log(`    - ${c.name} (${c.pendingDigest} new)`);
  }
}

main();
