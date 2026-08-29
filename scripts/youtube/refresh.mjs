#!/usr/bin/env node
// Deterministic daily/manual pipeline. Models only read staged windows and emit
// JSON; this trusted orchestrator owns every write and never mutates targets.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LOG_ROOT, YT_ROOT } from './lib/config.mjs';
import { loadPlaylistAllowlist, selectAllowlistedSources } from './lib/allowlist.mjs';
import { findVideoEvidence } from './lib/corpus.mjs';
import { mediaDoctor } from './lib/media.mjs';
import {
  createPlaylistSnapshot, loadSources, persistPlaylistSnapshot,
  readPlaylistManifest, saveSources,
} from './lib/sources.mjs';
import { listTarget } from './lib/ytdlp.mjs';
import { writeJsonAtomic } from './lib/records.mjs';
import { computeRunStatus } from './lib/outcomes.mjs';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function runNode(script, args, timeout) {
  const result = spawnSync(process.execPath, [join(YT_ROOT, script), ...args], {
    encoding: 'utf8', windowsHide: true, input: '', timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message || null };
}

function remaining(deadline) {
  return Math.max(1_000, deadline - Date.now());
}

function log(record) {
  mkdirSync(LOG_ROOT, { recursive: true });
  appendFileSync(join(LOG_ROOT, `refresh-${record.startedAt.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
}

const args = process.argv.slice(2);
const topicFlag = args.indexOf('--topic');
const requestedTopic = topicFlag === -1 ? args.filter((arg) => !arg.startsWith('--')).join(' ').trim() : args[topicFlag + 1];
const collectOnly = args.includes('--collect-only');
const allowlistOnly = args.includes('--allowlist-only');
const startedAt = new Date().toISOString();
const deadline = Date.now() + Number(process.env.YT_REFRESH_CEILING_MS || FOUR_HOURS_MS);
const run = { schemaVersion: 1, runId: startedAt.replace(/[:.]/g, '-'), startedAt, requestedTopic: requestedTopic || null, allowlistOnly, sources: [], videos: [], targets: [], status: 'NoChange', errors: [] };

try {
  const registry = loadSources({ persistMigration: true });
  const sources = allowlistOnly
    ? selectAllowlistedSources(registry, loadPlaylistAllowlist(), requestedTopic)
    : registry.sources.filter((source) => source.active
      && (!requestedTopic || source.id === requestedTopic || source.topic.toLowerCase() === requestedTopic.toLowerCase()));
  if (!sources.length) throw new Error(`No active sources matched "${requestedTopic || 'all'}".`);
  const toolReport = mediaDoctor();
  const collectorReady = toolReport.tools.find((tool) => tool.name === 'yt-dlp')?.available === true;

  for (const source of sources) {
    if (Date.now() >= deadline) break;
    if (!collectorReady) {
      run.sources.push({ sourceId: source.id, topic: source.topic, status: 'Blocked', reason: 'yt-dlp unavailable.' });
      run.videos.push({ sourceId: source.id, status: 'Blocked', reason: 'Playlist enumeration and ingestion require yt-dlp.' });
      continue;
    }
    try {
      const listing = listTarget(source.target, { limit: source.kind === 'channel' ? source.limit : undefined });
      if (allowlistOnly && source.kind === 'playlist' && listing.entries.length === 0) {
        throw new Error(`YouTube authentication/access blocked: allowlisted playlist ${source.playlistId} returned no entries; YT_COOKIES_FILE may be missing or expired.`);
      }
      let snapshot = null;
      if (source.kind === 'playlist') {
        source.playlistId = source.playlistId || listing.playlistId;
        snapshot = createPlaylistSnapshot(source, listing, { previous: readPlaylistManifest(source.playlistId) });
        persistPlaylistSnapshot(snapshot);
      }
      const completeMode = source.coverageMode === 'video-complete';
      const ingestArgs = [source.target, '--quiet', '--json'];
      if (completeMode) ingestArgs.push('--force');
      if (source.kind === 'channel') ingestArgs.push('--limit', String(source.limit || 25));
      const ingest = runNode('ingest.mjs', ingestArgs, Math.min(remaining(deadline), 60 * 60 * 1000));
      if (!ingest.ok) throw new Error(`ingest: ${ingest.error || ingest.stderr.slice(0, 800)}`);
      const ingested = JSON.parse(ingest.stdout);
      const sourceResult = {
        sourceId: source.id, topic: source.topic, listed: listing.entries.length,
        snapshotHash: snapshot?.snapshotHash || null, changes: snapshot?.changes || null,
        ingested: ingested.ingested, unavailable: ingested.unavailable || 0,
        failed: ingested.failed || 0,
      };
      if (sourceResult.failed > 0) {
        sourceResult.status = 'Blocked';
        sourceResult.reason = `Metadata/caption fetch failed for ${sourceResult.failed} listed video(s).`;
        run.sources.push(sourceResult);
        run.videos.push({ sourceId: source.id, status: 'Blocked', reason: sourceResult.reason });
        continue;
      }
      run.sources.push(sourceResult);

      if (!collectOnly && completeMode) {
        for (const entry of listing.entries) {
          if (Date.now() >= deadline) break;
          if (!entry.id) {
            run.videos.push({ entryKey: entry.entryKey || `position:${entry.position}`, status: 'Blocked', reason: entry.availability || 'unavailable' });
            continue;
          }
          if (entry.availability !== 'public') {
            run.videos.push({ videoId: entry.id, status: 'Blocked', reason: entry.availability });
            continue;
          }
          const evidencePath = findVideoEvidence(entry.id);
          if (!evidencePath) {
            run.videos.push({ videoId: entry.id, status: 'Failed', reason: 'No evidence record after ingestion.' });
            continue;
          }
          let evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
          if (evidence.coverageStatus !== 'READY') {
            if (!toolReport.ready) {
              run.videos.push({ videoId: entry.id, status: 'Blocked', reason: 'Media dependencies unavailable.' });
              continue;
            }
            const extraction = runNode('extract.mjs', [evidencePath], Math.min(remaining(deadline), 90 * 60 * 1000));
            if (!extraction.ok) {
              run.videos.push({ videoId: entry.id, status: extraction.status === 2 ? 'Blocked' : 'Failed', reason: (extraction.stderr || extraction.error || '').slice(0, 800) });
              continue;
            }
            const analysis = runNode('analyze.mjs', [evidencePath], Math.min(remaining(deadline), 60 * 60 * 1000));
            if (!analysis.ok) {
              run.videos.push({ videoId: entry.id, status: analysis.status === 2 ? 'Blocked' : 'Failed', reason: (analysis.stderr || analysis.error || '').slice(0, 800) });
              continue;
            }
            evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
          }
          run.videos.push({ videoId: entry.id, status: evidence.coverageStatus === 'READY' ? 'Ready' : 'Blocked' });
        }
      }
      source.lastPolledAt = new Date().toISOString();
    } catch (error) {
      if (/auth|cookie|private|sign.?in/i.test(error.message)) {
        run.sources.push({ sourceId: source.id, topic: source.topic, status: 'Blocked', reason: error.message });
        run.videos.push({ sourceId: source.id, status: 'Blocked', reason: error.message });
      } else {
        run.errors.push({ sourceId: source.id, detail: error.message });
      }
    }
  }
  saveSources(registry);

  const completeSources = sources.filter((source) => source.coverageMode === 'video-complete');
  const topics = [...new Set(completeSources.map((source) => source.topic))];
  if (!collectOnly && Date.now() < deadline) {
    for (const topic of topics) {
      const topicSources = completeSources.filter((source) => source.topic === topic);
      const currentSourceIds = new Set(run.sources
        .filter((source) => source.status !== 'Blocked' && Number.isFinite(source.listed))
        .map((source) => source.sourceId));
      if (allowlistOnly && topicSources.some((source) => !currentSourceIds.has(source.id))) continue;
      const topicArgs = [topic];
      if (allowlistOnly) topicArgs.push('--allowlist-only');
      const result = runNode('topic.mjs', topicArgs, Math.min(remaining(deadline), 10 * 60 * 1000));
      if (!result.ok && result.status !== 2) run.errors.push({ topic, detail: result.stderr.slice(0, 800) });
      if (result.ok) {
        const targetIds = [...new Set(topicSources.flatMap((source) => source.targetIds || []))];
        for (const targetId of targetIds) {
          const impact = runNode('target.mjs', ['impact', targetId], Math.min(remaining(deadline), 60 * 60 * 1000));
          run.targets.push({ targetId, status: impact.ok ? 'Ready' : 'Blocked', detail: (impact.stderr || '').slice(0, 800) });
        }
      }
    }
  }

  const changed = run.sources.some((source) => source.ingested > 0
    || (source.changes && Object.values(source.changes).some((items) => items.length)));
  run.status = computeRunStatus({
    deadlineExceeded: Date.now() >= deadline,
    errors: run.errors,
    completedSources: run.sources.length,
    videos: run.videos,
    targets: run.targets,
    changed,
  });
  if (collectOnly && completeSources.length > 0 && changed && run.status === 'Ready') run.status = 'Warn';
} catch (error) {
  run.status = 'Failed';
  run.errors.push({ detail: error.message });
}

run.finishedAt = new Date().toISOString();
run.elapsedMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
log(run);
writeJsonAtomic(join(LOG_ROOT, 'refresh-latest.json'), run);
console.log(JSON.stringify(run, null, 2));
if (run.status === 'Failed') process.exitCode = 1;
else if (run.status === 'Blocked' || run.status === 'Warn') process.exitCode = 2;
