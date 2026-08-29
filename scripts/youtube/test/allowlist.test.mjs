import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  loadPlaylistAllowlist, selectAllowlistedSources, sourcePlaylistId,
  synchronizeAllowlistedSources,
  validatePlaylistAllowlist,
} from '../lib/allowlist.mjs';
import { ytdlpAuthArgs } from '../lib/ytdlp.mjs';

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const YOUTUBE_ROOT = resolve(TEST_ROOT, '..');
const EXPECTED_PLAYLIST_IDS = [
  'PLg5FD0-TFyzP9PZmwFGw2VoADQubtACsi',
  'PLg5FD0-TFyzOG4GU_pykZhuVJi-aKi-xE',
  'PLg5FD0-TFyzPfZ1qAkcgqSXvfA7GVDcC8',
  'PLGB4mkrHM1jc',
  'PLg5FD0-TFyzPO5n9yD4ZqT91BoHe1FvzJ',
  'PLg5FD0-TFyzNwmPYCybhpQqcoAoOFu2v1',
  'PLAt38qX-zDTs',
  'PLE6eZbTQhX_s',
  'PLg5FD0-TFyzOvFDwnCKu0SvStm3pz5LLv',
];

function unrelatedSources() {
  return [
    {
      id: 'channel-unrelated', kind: 'channel', active: true,
      target: '@unrelated', topic: 'Unrelated channel', marker: 'preserve',
    },
    {
      id: 'playlist-unrelated', kind: 'playlist', active: true,
      target: 'https://www.youtube.com/playlist?list=PLunrelated123',
      playlistId: 'PLunrelated123', topic: 'Unrelated playlist', marker: 'preserve',
    },
  ];
}

test('continuous daily allowlist contains exactly the approved nine unique playlist IDs', () => {
  const allowlist = loadPlaylistAllowlist();
  const ids = allowlist.playlists.map((entry) => entry.playlistId);
  assert.equal(allowlist.strict, true);
  assert.equal(ids.length, 9);
  assert.equal(new Set(ids).size, 9);
  assert.deepEqual(ids, EXPECTED_PLAYLIST_IDS);
});

test('allowlist rejects a URL whose list parameter does not match its approved playlist ID', () => {
  const allowlist = structuredClone(loadPlaylistAllowlist());
  allowlist.playlists[0].url = 'https://www.youtube.com/playlist?list=PLunapproved123';
  assert.throws(() => validatePlaylistAllowlist(allowlist), /URL must match its playlistId/);
});

test('allowlist synchronization is deterministic and preserves unrelated registered sources', () => {
  const allowlist = loadPlaylistAllowlist();
  const unrelated = unrelatedSources();
  const existing = {
    id: 'old-id', kind: 'playlist', active: false,
    playlistId: EXPECTED_PLAYLIST_IDS[0], topic: 'Old topic',
    targetIds: ['deck'], addedAt: '2026-08-20T00:00:00.000Z',
  };
  const duplicate = { ...existing, id: 'duplicate-id', targetIds: [] };
  const input = { version: 2, sources: [...unrelated, existing, duplicate] };
  const first = synchronizeAllowlistedSources(input, allowlist, '2026-08-26T00:00:00.000Z');
  const second = synchronizeAllowlistedSources(first.registry, allowlist, '2026-08-27T00:00:00.000Z');

  assert.deepEqual(input.sources, [...unrelated, existing, duplicate], 'sync must not mutate caller state');
  assert.deepEqual(first.registry.sources.slice(0, 2), unrelated);
  assert.deepEqual(second.registry, first.registry, 'repeat sync must not create timestamp drift');
  assert.equal(first.registry.sources.length, 11);
  assert.equal(first.registry.sources.filter((source) => source.managedBy === 'continuous-playlist-allowlist').length, 9);
  assert.deepEqual(first.registry.sources.find((source) => sourcePlaylistId(source) === EXPECTED_PLAYLIST_IDS[0]).targetIds, ['deck']);
});

test('strict selection excludes active channels and unrelated playlists', () => {
  const allowlist = loadPlaylistAllowlist();
  const registry = synchronizeAllowlistedSources(
    { version: 2, sources: unrelatedSources() }, allowlist, '2026-08-26T00:00:00.000Z',
  ).registry;
  const selected = selectAllowlistedSources(registry, allowlist);

  assert.equal(selected.length, 9);
  assert.deepEqual(selected.map(sourcePlaylistId), EXPECTED_PLAYLIST_IDS);
  assert.ok(selected.every((source) => source.kind === 'playlist' && source.active));
});

test('strict selection fails when any allowlisted source is missing or inactive', () => {
  const allowlist = loadPlaylistAllowlist();
  const registry = synchronizeAllowlistedSources(
    { version: 2, sources: [] }, allowlist, '2026-08-26T00:00:00.000Z',
  ).registry;
  registry.sources.find((source) => sourcePlaylistId(source) === EXPECTED_PLAYLIST_IDS[4]).active = false;

  assert.throws(
    () => selectAllowlistedSources(registry, allowlist),
    new RegExp(`not registered and active.*${EXPECTED_PLAYLIST_IDS[4]}`),
  );
});

test('strict selection fails closed when the registry duplicates an allowlisted playlist', () => {
  const allowlist = loadPlaylistAllowlist();
  const registry = synchronizeAllowlistedSources(
    { version: 2, sources: [] }, allowlist, '2026-08-26T00:00:00.000Z',
  ).registry;
  registry.sources.push({ ...registry.sources[0], id: 'duplicate-allowlisted-source' });

  assert.throws(
    () => selectAllowlistedSources(registry, allowlist),
    new RegExp(`duplicate active sources.*${EXPECTED_PLAYLIST_IDS[0]}`, 'i'),
  );
});

test('source sync-allowlist command writes the nine managed sources without removing unrelated entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'yt-allowlist-command-'));
  const sourcesPath = join(root, 'sources.json');
  try {
    writeFileSync(sourcesPath, `${JSON.stringify({ version: 2, sources: unrelatedSources() }, null, 2)}\n`, 'utf8');
    const result = spawnSync(process.execPath, [join(YOUTUBE_ROOT, 'source.mjs'), 'sync-allowlist'], {
      cwd: resolve(YOUTUBE_ROOT, '..', '..'),
      env: {
        ...process.env,
        YT_SOURCES_PATH: sourcesPath,
        YT_PLAYLIST_ALLOWLIST_PATH: join(YOUTUBE_ROOT, 'state', 'continuous-playlists.json'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const registry = JSON.parse(readFileSync(sourcesPath, 'utf8'));
    assert.deepEqual(registry.sources.slice(0, 2), unrelatedSources());
    assert.equal(registry.sources.filter((source) => source.managedBy === 'continuous-playlist-allowlist').length, 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cookie authentication arguments never read or expose cookie contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'yt-cookie-args-'));
  const cookiePath = join(root, 'youtube-cookies.txt');
  const secret = 'SID=do-not-expose-this-cookie';
  try {
    writeFileSync(cookiePath, secret, 'utf8');
    const fileArgs = ytdlpAuthArgs({
      env: { YT_COOKIES_FILE: cookiePath, YT_COOKIES_FROM_BROWSER: 'chrome' },
    });
    assert.deepEqual(fileArgs, ['--cookies', resolve(cookiePath)]);
    assert.doesNotMatch(JSON.stringify(fileArgs), new RegExp(secret));
    assert.deepEqual(ytdlpAuthArgs({ env: { YT_COOKIES_FROM_BROWSER: 'firefox' } }), ['--cookies-from-browser', 'firefox']);
    assert.deepEqual(ytdlpAuthArgs({ env: {} }), []);
    assert.throws(
      () => ytdlpAuthArgs({ env: { YT_COOKIES_FILE: join(root, 'missing.txt') } }),
      /authentication blocked.*YT_COOKIES_FILE does not exist/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict CLI and scheduled wrapper contract cannot fall back to unrelated sources or browser cookies', () => {
  const refresh = readFileSync(join(YOUTUBE_ROOT, 'refresh.mjs'), 'utf8');
  const topic = readFileSync(join(YOUTUBE_ROOT, 'topic.mjs'), 'utf8');
  const ytdlp = readFileSync(join(YOUTUBE_ROOT, 'lib', 'ytdlp.mjs'), 'utf8');
  const media = readFileSync(join(YOUTUBE_ROOT, 'lib', 'media.mjs'), 'utf8');
  const wrapper = readFileSync(join(YOUTUBE_ROOT, 'scheduled-youtube-refresh.bat'), 'utf8');

  assert.match(refresh, /--allowlist-only/);
  assert.match(topic, /--allowlist-only/);
  assert.equal([...ytdlp.matchAll(/authenticated:\s*true/g)].length, 2, 'playlist listing and caption/metadata fetch must authenticate');
  assert.match(media, /ytdlpAuthArgs\(/);
  assert.match(wrapper, /set "YT_COOKIES_FILE=%USERPROFILE%\\\.claude\\secrets\\youtube-cookies\.txt"/i);
  assert.match(wrapper, /set "YT_PLAYLIST_ALLOWLIST_PATH=%REPO%\\scripts\\youtube\\state\\continuous-playlists\.json"/i);
  assert.match(wrapper, /source\.mjs" sync-allowlist/i);
  assert.match(wrapper, /refresh\.mjs" --allowlist-only/i);
  assert.doesNotMatch(wrapper, /cookies-from-browser/i);
});

test('skill, workflow, headless safety, and README all document the exact strict boundary', () => {
  const documents = [
    join(YOUTUBE_ROOT, 'README.md'),
    join(YOUTUBE_ROOT, '..', '..', '.claude', 'skills', 'youtube-research', 'SKILL.md'),
    join(YOUTUBE_ROOT, '..', '..', '.claude', 'skills', 'youtube-research', 'references', 'continuous-workflow.md'),
    join(YOUTUBE_ROOT, '..', '..', '.claude', 'skills', 'youtube-research', 'references', 'headless-safety.md'),
  ].map((path) => readFileSync(path, 'utf8'));

  for (const document of documents) {
    for (const playlistId of EXPECTED_PLAYLIST_IDS) assert.match(document, new RegExp(playlistId));
    assert.match(document, /screenshot/i);
  }
});
