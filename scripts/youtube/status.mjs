#!/usr/bin/env node
// status.mjs — what is in the corpus, what is subscribed, what is pending.
//
//   node scripts/youtube/status.mjs [--json]
//
// The one-screen answer to "what do I actually have to research over?".
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { corpusStats, dirSizeBytes, channelDir } from './lib/corpus.mjs';
import { DIGEST_INDEX, CORPUS_ROOT, TOPICS_ROOT } from './lib/config.mjs';
import { loadSources } from './lib/sources.mjs';

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
  const registry = loadSources();
  const watched = new Set(registry.sources.map((source) => source.slug));

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
    sources: registry.sources,
    watchlist: registry.sources.filter((source) => source.kind === 'channel'),
    channels,
    topics: existsSync(TOPICS_ROOT) ? readdirSync(TOPICS_ROOT, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => {
      const path = join(TOPICS_ROOT, item.name, 'coverage.json');
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { topic: item.name, status: 'BLOCKED', unresolved: [{ reason: 'No coverage record.' }] };
    }) : [],
  };

  if (json) { console.log(JSON.stringify(payload, null, 2)); return; }

  console.log(`Corpus: ${CORPUS_ROOT}`);
  console.log(`  ${payload.totalChannels} channel(s) · ${payload.totalVideos} video(s) · ${payload.totalWords.toLocaleString('en-US')} words · ${payload.digests} digest(s)\n`);

  if (channels.length === 0) {
    console.log('  (empty — run: node scripts/youtube/ingest.mjs "@channel" --limit 10)');
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

  const pending = registry.sources.filter((source) => source.pendingDigest);
  if (pending.length) {
    console.log(`\n  ${pending.length} channel(s) have new videos awaiting a digest:`);
    for (const c of pending) console.log(`    - ${c.name} (${c.pendingDigest} new)`);
  }
  if (payload.topics.length) {
    console.log('\n  Topic coverage:');
    for (const topic of payload.topics) console.log(`    - ${topic.topic || 'unknown'}: ${topic.status} (${topic.accounting?.unresolved ?? '?'} unresolved)`);
  }
}

main();
