import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlaylistSnapshot,
  diffPlaylistEntries,
  migrateWatchlist,
} from '../lib/sources.mjs';
import { entryAvailability } from '../lib/ytdlp.mjs';

test('watchlist migration preserves channel settings without mutating the input', () => {
  const watchlist = {
    version: 1,
    channels: [{ slug: 'creator', name: 'Creator', target: '@creator', limit: 8, topic: 'Agents', paused: false }],
  };
  const migrated = migrateWatchlist(watchlist, '2026-08-24T00:00:00.000Z');
  assert.equal(watchlist.version, 1);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.sources[0], {
    id: 'channel-creator',
    kind: 'channel',
    slug: 'creator',
    name: 'Creator',
    target: '@creator',
    url: null,
    channelId: null,
    topic: 'Agents',
    cadence: 'daily',
    coverageMode: 'standard',
    active: true,
    limit: 8,
    targetIds: [],
    addedAt: '2026-08-24T00:00:00.000Z',
  });
});

test('playlist diff accounts for additions, removals, reorders, duplicates, and unavailable entries', () => {
  const previous = [
    { id: 'a', position: 1, availability: 'public' },
    { id: 'b', position: 2, availability: 'public' },
    { id: 'b', position: 3, availability: 'public' },
    { id: null, position: 4, availability: 'private', entryKey: 'position:4' },
  ];
  const current = [
    { id: 'b', position: 1, availability: 'public' },
    { id: 'a', position: 2, availability: 'public' },
    { id: 'c', position: 3, availability: 'public' },
    { id: null, position: 4, availability: 'unavailable', entryKey: 'position:4' },
  ];
  const diff = diffPlaylistEntries(previous, current);
  assert.deepEqual(diff.added.map((entry) => entry.id), ['c']);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].id, 'b');
  assert.equal(diff.reordered.length, 2);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].after.availability, 'unavailable');
});

test('playlist snapshots are stable and include every entry beyond legacy channel limits', () => {
  const entries = Array.from({ length: 31 }, (_, i) => ({
    id: `video-${i}`,
    title: `Video ${i}`,
    position: i + 1,
    availability: 'public',
  }));
  const snapshot = createPlaylistSnapshot(
    { id: 'playlist-test', playlistId: 'PLtest', topic: 'Test' },
    { title: 'Playlist', entries },
    { capturedAt: '2026-08-24T00:00:00.000Z' },
  );
  assert.equal(snapshot.entries.length, 31);
  assert.equal(snapshot.entries[30].position, 31);
  assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/);
});

test('unavailable playlist placeholders are classified even when yt-dlp exposes an id', () => {
  assert.equal(entryAvailability({ id: 'private-id', title: '[Private video]' }), 'private');
  assert.equal(entryAvailability({ id: 'deleted-id', title: '[Deleted video]' }), 'removed');
  assert.equal(entryAvailability({ id: null, title: null }), 'unavailable');
});
