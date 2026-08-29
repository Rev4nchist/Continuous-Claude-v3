import { existsSync, readFileSync } from 'node:fs';
import { PLAYLIST_ALLOWLIST_PATH, slugify } from './config.mjs';

const MANAGER = 'continuous-playlist-allowlist';
const STRICT_PLAYLIST_COUNT = 9;

function playlistIdFromUrl(value) {
  try { return new URL(value).searchParams.get('list'); } catch { return null; }
}

export function sourcePlaylistId(source) {
  return source?.playlistId || playlistIdFromUrl(source?.target || source?.url || '');
}

export function validatePlaylistAllowlist(document) {
  if (document?.version !== 1 || document?.strict !== true || !Array.isArray(document.playlists)) {
    throw new Error('Playlist allowlist must be version 1, strict, and contain a playlists array.');
  }
  const ids = document.playlists.map((entry) => entry.playlistId);
  if (ids.length !== STRICT_PLAYLIST_COUNT) {
    throw new Error(`Strict daily playlist allowlist must contain exactly ${STRICT_PLAYLIST_COUNT} entries.`);
  }
  if (ids.some((id) => !/^[A-Za-z0-9_-]{10,}$/.test(id || ''))) throw new Error('Playlist allowlist contains an invalid playlistId.');
  if (new Set(ids).size !== ids.length) throw new Error('Playlist allowlist contains duplicate playlist IDs.');
  if (document.playlists.some((entry) => !entry.name || !entry.topic)) throw new Error('Every allowlisted playlist requires name and topic.');
  if (document.playlists.some((entry) => entry.url && playlistIdFromUrl(entry.url) !== entry.playlistId)) {
    throw new Error('Every allowlisted playlist URL must match its playlistId.');
  }
  if (document.playlists.some((entry) => entry.enabled === false)) throw new Error('Strict daily playlist entries cannot be disabled.');
  return document;
}

export function loadPlaylistAllowlist(path = PLAYLIST_ALLOWLIST_PATH) {
  if (!existsSync(path)) throw new Error(`Playlist allowlist not found: ${path}`);
  return validatePlaylistAllowlist(JSON.parse(readFileSync(path, 'utf8')));
}

function sourceRecord(entry, existing, now) {
  const url = `https://www.youtube.com/playlist?list=${entry.playlistId}`;
  return {
    ...existing,
    id: `playlist-${slugify(entry.playlistId)}`,
    kind: 'playlist', slug: slugify(entry.name), name: entry.name,
    target: url, url, playlistId: entry.playlistId, channelId: null,
    topic: entry.topic, cadence: 'daily', coverageMode: 'video-complete',
    active: true, limit: null,
    targetIds: existing?.targetIds || [], addedAt: existing?.addedAt || now,
    managedBy: MANAGER,
  };
}

export function synchronizeAllowlistedSources(registry, allowlist, now = new Date().toISOString()) {
  validatePlaylistAllowlist(allowlist);
  const entries = new Map(allowlist.playlists.map((entry) => [entry.playlistId, entry]));
  const synchronized = new Set();
  const sources = [];
  const added = [];
  for (const source of registry.sources || []) {
    const playlistId = sourcePlaylistId(source);
    const entry = entries.get(playlistId);
    if (!entry) {
      sources.push({ ...source });
      continue;
    }
    if (synchronized.has(playlistId)) continue;
    sources.push(sourceRecord(entry, source, now));
    synchronized.add(playlistId);
  }
  for (const entry of allowlist.playlists) {
    if (synchronized.has(entry.playlistId)) continue;
    const record = sourceRecord(entry, null, now);
    sources.push(record);
    added.push(record.id);
  }
  return { registry: { ...registry, sources }, added };
}

export function selectAllowlistedSources(registry, allowlist, requestedTopic = null) {
  validatePlaylistAllowlist(allowlist);
  const allowed = new Set(allowlist.playlists.map((entry) => entry.playlistId));
  const selected = (registry.sources || []).filter((source) => source.active && source.kind === 'playlist'
    && allowed.has(sourcePlaylistId(source)));
  const selectedIds = selected.map(sourcePlaylistId);
  const duplicates = selectedIds.filter((id, index) => selectedIds.indexOf(id) !== index);
  if (duplicates.length) {
    throw new Error(`Allowlisted playlists have duplicate active sources: ${[...new Set(duplicates)].join(', ')}`);
  }
  const found = new Set(selectedIds);
  const missing = [...allowed].filter((id) => !found.has(id));
  if (missing.length) throw new Error(`Allowlisted playlists are not registered and active: ${missing.join(', ')}`);
  if (!requestedTopic) return selected;
  return selected.filter((source) => source.id === requestedTopic
    || source.topic.toLowerCase() === requestedTopic.toLowerCase());
}
