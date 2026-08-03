#!/usr/bin/env node
// ingest.mjs — pull YouTube videos into the on-disk research corpus.
//
//   node scripts/ingest.mjs <target> [options]
//
//   <target>   @handle | channel URL | playlist URL | video URL | 11-char id
//   --limit N        cap videos pulled (default 25 for channels; ignored for a
//                    single video)
//   --since DATE     only videos uploaded on/after YYYY-MM-DD
//   --force          re-ingest ids already in the corpus
//   --no-transcript  metadata only (fast; skips subtitle requests)
//   --json           emit a machine-readable summary on stdout
//   --quiet          suppress progress lines
//
// Incremental by construction: ids already present in the corpus are skipped
// before any network call, so re-running against a channel costs one flat-list
// request and fetches only genuinely new uploads.
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CHANNEL_LIMIT, slugify, formatTimestamp,
} from './lib/config.mjs';
import {
  listTarget, fetchVideos, readInfoJson, readBestSubtitle, ytdlpVersion,
} from './lib/ytdlp.mjs';
import { vttToChunks, countWords } from './lib/vtt.mjs';
import {
  allIngestedIds, renderVideoDoc, writeVideoDoc, readChannelState,
  writeChannelState, ensureDir, channelDir,
} from './lib/corpus.mjs';

function parseArgs(argv) {
  const opts = {
    target: null, limit: null, since: null,
    force: false, transcript: true, json: false, quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') { opts.limit = Number(argv[++i]); continue; }
    if (a === '--since') { opts.since = argv[++i]; continue; }
    if (a === '--force') { opts.force = true; continue; }
    if (a === '--no-transcript') { opts.transcript = false; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--quiet') { opts.quiet = true; continue; }
    if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    if (!opts.target) opts.target = a;
    else throw new Error(`Unexpected extra argument: ${a}`);
  }
  if (!opts.target) throw new Error('Usage: ingest.mjs <@handle|url|video-id> [--limit N] [--since YYYY-MM-DD] [--force]');
  if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
    throw new Error(`--since must be YYYY-MM-DD, got "${opts.since}"`);
  }
  return opts;
}

// yt-dlp gives upload_date as YYYYMMDD.
function isoDate(yyyymmdd) {
  const s = String(yyyymmdd || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : 'unknown';
}

// Was the chosen caption track human-authored or ASR? Recorded per video so a
// digest can weight a quote from a clean manual track above an ASR guess.
function transcriptSource(info, lang) {
  if (info?.subtitles && Object.keys(info.subtitles).includes(lang)) return 'manual';
  return 'auto';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (...a) => { if (!opts.quiet && !opts.json) console.log(...a); };

  log(`yt-dlp ${ytdlpVersion()}`);
  log(`Resolving ${opts.target} ...`);

  const limit = opts.limit ?? DEFAULT_CHANNEL_LIMIT;
  const listing = listTarget(opts.target, { limit });
  log(`  ${listing.kind}: ${listing.channel} — ${listing.entries.length} video(s) listed`);

  const known = opts.force ? new Set() : allIngestedIds();
  const todo = listing.entries.filter((e) => !known.has(e.id));
  const skipped = listing.entries.length - todo.length;

  if (skipped) log(`  ${skipped} already in corpus, skipping`);
  if (todo.length === 0) {
    const summary = {
      target: opts.target, listed: listing.entries.length,
      ingested: 0, skipped, failed: 0, noCaptions: 0, files: [],
    };
    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    else log('Nothing new to ingest.');
    return;
  }

  log(`  fetching ${todo.length} video(s) ...`);

  // Staging dir under the OS temp root — created by us, removed by us.
  const stage = mkdtempSync(join(tmpdir(), 'yt-ingest-'));
  const result = {
    target: opts.target, listed: listing.entries.length,
    ingested: 0, skipped, failed: 0, noCaptions: 0, files: [],
  };

  try {
    const ids = todo.map((e) => e.id);
    const fetchRes = fetchVideos(ids, stage, {
      since: opts.since,
      transcript: opts.transcript,
    });

    if (fetchRes.status !== 0) {
      log('  (yt-dlp reported partial failures — continuing with what landed)');
    }

    const touchedChannels = new Map();

    for (const entry of todo) {
      const info = readInfoJson(stage, entry.id);
      if (!info) {
        result.failed += 1;
        log(`  ! ${entry.id} — no metadata (deleted, private, or region-locked)`);
        continue;
      }

      // --since is enforced by yt-dlp's --dateafter during fetch, but a video
      // whose date only appears in info.json is re-checked here so the filter is
      // honest regardless of which path supplied the date.
      const upload = isoDate(info.upload_date);
      if (opts.since && upload !== 'unknown' && upload < opts.since) continue;

      const channelName = info.channel || info.uploader || listing.channel || 'Unknown';
      const channelSlug = slugify(channelName);

      let chunks = [];
      let lang = null;
      let source = null;
      if (opts.transcript) {
        const sub = readBestSubtitle(stage, entry.id);
        if (sub) {
          lang = sub.lang;
          source = transcriptSource(info, sub.lang);
          chunks = vttToChunks(sub.text);
        } else {
          result.noCaptions += 1;
        }
      }

      const meta = {
        video_id: info.id,
        title: info.title || entry.title,
        channel: channelName,
        channel_id: info.channel_id || null,
        channel_slug: channelSlug,
        url: info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`,
        upload_date: upload,
        duration_s: info.duration ?? null,
        duration: info.duration ? formatTimestamp(info.duration) : null,
        view_count: info.view_count ?? null,
        like_count: info.like_count ?? null,
        subtitle_lang: lang,
        transcript_source: source,
        transcript_words: chunks.length ? countWords(chunks) : 0,
        ingested_at: new Date().toISOString(),
        ingest_version: 1,
      };

      const doc = renderVideoDoc({
        meta,
        description: info.description,
        chapters: info.chapters,
        chunks,
      });

      const path = writeVideoDoc(channelSlug, meta, doc);
      result.ingested += 1;
      result.files.push({
        videoId: meta.video_id, title: meta.title, channel: channelSlug,
        uploadDate: meta.upload_date, words: meta.transcript_words, path,
      });

      touchedChannels.set(channelSlug, channelName);
      log(`  + ${meta.upload_date}  ${meta.transcript_words.toString().padStart(6)}w  ${meta.title.slice(0, 62)}`);
    }

    // Per-channel ingest state (drives the poller's "what's new since" check).
    for (const [slug, name] of touchedChannels) {
      ensureDir(channelDir(slug));
      const prev = readChannelState(slug) || {};
      writeChannelState(slug, {
        ...prev,
        channelSlug: slug,
        channelName: name,
        channelId: listing.channelId || prev.channelId || null,
        lastIngestAt: new Date().toISOString(),
        lastTarget: opts.target,
      });
    }
  } finally {
    // Only ever removes the mkdtemp dir this process created.
    rmSync(stage, { recursive: true, force: true });
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    log('');
    log(`Ingested ${result.ingested} · skipped ${result.skipped} · failed ${result.failed} · no captions ${result.noCaptions}`);
  }
}

main().catch((e) => {
  console.error(`ingest failed: ${e.message}`);
  process.exit(1);
});
