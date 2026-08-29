import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLAYLISTS_ROOT, SOURCES_PATH, WATCHLIST_PATH, slugify,
} from './config.mjs';
import { contentHash, writeJsonAtomic } from './records.mjs';

const REGISTRY_VERSION = 2;

export function migrateWatchlist(watchlist, now = new Date().toISOString()) {
  const channels = Array.isArray(watchlist?.channels) ? watchlist.channels : [];
  return {
    version: REGISTRY_VERSION,
    migratedFromWatchlistVersion: watchlist?.version ?? null,
    sources: channels.map((channel) => ({
      id: `channel-${channel.slug || slugify(channel.name || channel.target)}`,
      kind: 'channel',
      slug: channel.slug || slugify(channel.name || channel.target),
      name: channel.name || channel.target,
      target: channel.target,
      url: channel.url ?? null,
      channelId: channel.channelId ?? null,
      topic: channel.topic || 'Uncategorized',
      cadence: 'daily',
      coverageMode: 'standard',
      active: channel.paused !== true,
      limit: channel.limit ?? 25,
      targetIds: [],
      addedAt: channel.addedAt || now,
    })),
  };
}

export function loadSources({ persistMigration = false } = {}) {
  if (existsSync(SOURCES_PATH)) return JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
  const watchlist = existsSync(WATCHLIST_PATH)
    ? JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8'))
    : { version: 1, channels: [] };
  const registry = migrateWatchlist(watchlist);
  if (persistMigration) writeJsonAtomic(SOURCES_PATH, registry);
  return registry;
}

export function saveSources(registry) {
  if (registry?.version !== REGISTRY_VERSION || !Array.isArray(registry.sources)) {
    throw new Error('Invalid source registry: expected version 2 with a sources array.');
  }
  writeJsonAtomic(SOURCES_PATH, registry);
}

function entryIdentity(entry, occurrences) {
  if (!entry.id) return entry.entryKey || `position:${entry.position}`;
  const ordinal = (occurrences.get(entry.id) || 0) + 1;
  occurrences.set(entry.id, ordinal);
  return `id:${entry.id}#${ordinal}`;
}

function indexEntries(entries) {
  const occurrences = new Map();
  return new Map((entries || []).map((entry, index) => {
    const normalized = { ...entry, position: entry.position ?? index + 1 };
    const key = entryIdentity(normalized, occurrences);
    return [key, { ...normalized, entryKey: normalized.entryKey || key }];
  }));
}

export function diffPlaylistEntries(previous = [], current = []) {
  const before = indexEntries(previous);
  const after = indexEntries(current);
  const added = [];
  const removed = [];
  const reordered = [];
  const changed = [];

  for (const [key, entry] of after) {
    const prior = before.get(key);
    if (!prior) {
      added.push(entry);
      continue;
    }
    if (prior.position !== entry.position) reordered.push({ entryKey: key, before: prior.position, after: entry.position });
    const priorComparable = { ...prior, position: entry.position, entryKey: entry.entryKey };
    if (contentHash(priorComparable) !== contentHash(entry)) changed.push({ entryKey: key, before: prior, after: entry });
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push(entry);
  }
  return { added, removed, reordered, changed };
}

function normalizeSnapshotEntries(entries = []) {
  const occurrences = new Map();
  return entries.map((entry, index) => {
    const position = entry.position ?? entry.playlistIndex ?? index + 1;
    const normalized = {
      id: entry.id ?? null,
      title: entry.title || '(unavailable)',
      url: entry.url ?? (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null),
      position,
      duration: entry.duration ?? null,
      channel: entry.channel ?? null,
      availability: entry.availability || (entry.id ? 'public' : 'unavailable'),
    };
    normalized.entryKey = entry.entryKey || entryIdentity(normalized, occurrences);
    return normalized;
  });
}

export function createPlaylistSnapshot(source, listing, {
  capturedAt = new Date().toISOString(), previous = null,
} = {}) {
  const entries = normalizeSnapshotEntries(listing.entries);
  const identity = {
    schemaVersion: 1,
    sourceId: source.id,
    playlistId: source.playlistId || listing.playlistId || null,
    topic: source.topic,
    title: listing.title || source.name || null,
    entries,
  };
  return {
    ...identity,
    capturedAt,
    changes: diffPlaylistEntries(previous?.entries || [], entries),
    snapshotHash: contentHash(identity),
  };
}

export function persistPlaylistSnapshot(snapshot) {
  if (!snapshot.playlistId) throw new Error('Playlist snapshot requires playlistId.');
  const root = join(PLAYLISTS_ROOT, snapshot.playlistId);
  const stamp = snapshot.capturedAt.replace(/[:.]/g, '-');
  writeJsonAtomic(join(root, 'snapshots', `${stamp}-${snapshot.snapshotHash.slice(0, 12)}.json`), snapshot);
  writeJsonAtomic(join(root, 'manifest.json'), snapshot);
  return root;
}

export function readPlaylistManifest(playlistId) {
  const path = join(PLAYLISTS_ROOT, playlistId, 'manifest.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
