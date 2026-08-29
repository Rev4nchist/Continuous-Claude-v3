#!/usr/bin/env node
// Versioned source registry for channels, complete playlists, and videos.
import { slugify } from './lib/config.mjs';
import { loadPlaylistAllowlist, synchronizeAllowlistedSources } from './lib/allowlist.mjs';
import {
  createPlaylistSnapshot, loadSources, persistPlaylistSnapshot, readPlaylistManifest, saveSources,
} from './lib/sources.mjs';
import { listTarget, normalizeTarget, targetKindHint } from './lib/ytdlp.mjs';

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function list(registry) {
  console.log(JSON.stringify(registry, null, 2));
}

function syncAllowlist(registry) {
  const allowlist = loadPlaylistAllowlist();
  const { registry: synchronized, added } = synchronizeAllowlistedSources(
    registry, allowlist,
  );
  saveSources(synchronized);
  console.log(JSON.stringify({
    status: 'Synchronized', managedSources: allowlist.playlists.length,
    added, sources: synchronized.sources.length,
  }, null, 2));
}

function add(registry, args) {
  const target = args[0];
  const topic = flagValue(args, '--topic');
  if (!target || !topic) throw new Error('Usage: source.mjs add <url|@channel> --topic <topic> [--cadence daily] [--target-id id]');
  const hint = targetKindHint(target);
  const limitValue = flagValue(args, '--limit');
  const listing = listTarget(target, { limit: hint === 'channel' ? Number(limitValue || 25) : undefined });
  const kind = hint === 'unknown' ? listing.kind : hint;
  const sourceId = `${kind}-${slugify(listing.playlistId || listing.channelId || listing.title || target)}`;
  if (registry.sources.some((source) => source.id === sourceId)) {
    console.log(JSON.stringify(registry.sources.find((source) => source.id === sourceId), null, 2));
    return;
  }
  const source = {
    id: sourceId,
    kind,
    slug: slugify(listing.title || listing.channel || sourceId),
    name: listing.title || listing.channel || target,
    target,
    url: normalizeTarget(target),
    playlistId: kind === 'playlist' ? listing.playlistId : null,
    channelId: listing.channelId || null,
    topic,
    cadence: flagValue(args, '--cadence') || 'daily',
    coverageMode: kind === 'playlist' ? 'video-complete' : 'standard',
    active: true,
    limit: kind === 'channel' ? Number(limitValue || 25) : null,
    targetIds: args.flatMap((value, index) => value === '--target-id' ? [args[index + 1]] : []),
    addedAt: new Date().toISOString(),
  };
  registry.sources.push(source);
  saveSources(registry);
  if (kind === 'playlist') {
    persistPlaylistSnapshot(createPlaylistSnapshot(source, listing));
  }
  console.log(JSON.stringify(source, null, 2));
}

function snapshot(registry, idOrTopic) {
  const matches = registry.sources.filter((source) => source.active && source.kind === 'playlist'
    && (!idOrTopic || source.id === idOrTopic || source.topic.toLowerCase() === idOrTopic.toLowerCase()));
  if (!matches.length) throw new Error(`No active playlist source matched "${idOrTopic || ''}".`);
  const results = matches.map((source) => {
    const listing = listTarget(source.target); // playlists are intentionally unbounded
    if (!source.playlistId) source.playlistId = listing.playlistId;
    const record = createPlaylistSnapshot(source, listing, { previous: readPlaylistManifest(source.playlistId) });
    persistPlaylistSnapshot(record);
    return { sourceId: source.id, playlistId: source.playlistId, entries: record.entries.length, changes: record.changes, snapshotHash: record.snapshotHash };
  });
  saveSources(registry);
  console.log(JSON.stringify(results, null, 2));
}

function toggle(registry, id, active) {
  const source = registry.sources.find((item) => item.id === id);
  if (!source) throw new Error(`Unknown source: ${id}`);
  source.active = active;
  saveSources(registry);
  console.log(`${id}: ${active ? 'active' : 'paused'}`);
}

function remove(registry, id) {
  const source = registry.sources.find((item) => item.id === id || item.slug === id);
  if (!source) throw new Error(`Unknown source: ${id}`);
  source.active = false;
  source.removedAt = new Date().toISOString();
  saveSources(registry);
  console.log(`${source.id}: inactive; corpus and playlist history retained`);
}

try {
  const [command = 'list', ...args] = process.argv.slice(2);
  const registry = loadSources({ persistMigration: command !== 'list' });
  if (command === 'list') list(registry);
  else if (command === 'sync-allowlist') syncAllowlist(registry);
  else if (command === 'add') add(registry, args);
  else if (command === 'snapshot') snapshot(registry, args[0]);
  else if (command === 'pause') toggle(registry, args[0], false);
  else if (command === 'resume') toggle(registry, args[0], true);
  else if (command === 'remove') remove(registry, args[0]);
  else throw new Error('Use: list | sync-allowlist | add | snapshot | pause | resume | remove');
} catch (error) {
  console.error(`source failed: ${error.message}`);
  process.exit(1);
}
