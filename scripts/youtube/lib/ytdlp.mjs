// ytdlp.mjs — thin, deterministic wrapper over yt-dlp.
// ESM, no external deps. Same posture as the codex/grok workers: bounded by an
// EXTERNAL timeout (never trust the tool to self-terminate on Windows), fail
// loud, and never shell-interpolate user input.
//
// Cost model: a channel ingest is TWO processes total, not two-per-video.
//   1. one flat-playlist call  -> the id list (fast, no per-video extraction)
//   2. one batched fetch call  -> info.json + .vtt for every new id
// yt-dlp accepts many URLs in a single invocation, so batching is free.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  YTDLP_EXE, YTDLP_TIMEOUT_MS, SUB_LANGS, SUB_LANG_PREFERENCE, SLEEP_REQUESTS_S,
} from './config.mjs';

export function ytdlpAuthArgs({ env = process.env } = {}) {
  const cookieFile = String(env.YT_COOKIES_FILE || '').trim();
  if (cookieFile) {
    if (/[\r\n\0]/.test(cookieFile)) throw new Error('Invalid YT_COOKIES_FILE value.');
    const path = resolve(cookieFile);
    if (!existsSync(path)) {
      throw new Error(`YouTube authentication blocked: YT_COOKIES_FILE does not exist: ${path}`);
    }
    return ['--cookies', path];
  }
  const browser = String(env.YT_COOKIES_FROM_BROWSER || '').trim();
  if (!browser) return [];
  if (/[\r\n\0]/.test(browser)) throw new Error('Invalid YT_COOKIES_FROM_BROWSER value.');
  return ['--cookies-from-browser', browser];
}

function run(args, {
  timeout = YTDLP_TIMEOUT_MS, allowFailure = false, authenticated = false,
} = {}) {
  const commandArgs = authenticated ? [...ytdlpAuthArgs(), ...args] : args;
  const res = spawnSync(YTDLP_EXE, commandArgs, {
    timeout,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024, // channel JSON for a large channel is big
    input: '', // close stdin — never inherit a TTY
  });

  if (res.error) {
    if (res.error.code === 'ENOENT') {
      throw new Error(
        `yt-dlp not found (tried "${YTDLP_EXE}"). Install it or set YTDLP_EXE.`,
      );
    }
    throw new Error(`yt-dlp spawn failed: ${res.error.message}`);
  }

  // Non-zero with --ignore-errors still means "some entries failed", which for a
  // batch is expected (members-only / deleted / region-locked videos).
  if (res.status !== 0 && !allowFailure) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 1200);
    throw new Error(`yt-dlp exited ${res.status}: ${detail}`);
  }

  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

export function ytdlpVersion() {
  return run(['--version']).stdout.trim();
}

// Normalize what a human types into something yt-dlp resolves.
//   @handle            -> https://www.youtube.com/@handle/videos
//   youtube.com/@h     -> .../videos   (channel root redirects to Home, which is
//                                       a curated shelf, NOT the full upload list)
// Everything else (watch?v=, playlist?list=, youtu.be/) passes through.
export function normalizeTarget(target) {
  const t = String(target).trim();

  if (/^@[\w.-]+$/.test(t)) return `https://www.youtube.com/${t}/videos`;

  if (/^https?:\/\//i.test(t)) {
    // A channel URL with no tab resolves to Home; force the uploads tab.
    if (/youtube\.com\/(@[\w.-]+|c\/[\w.-]+|channel\/[\w-]+|user\/[\w.-]+)\/?$/i.test(t)) {
      return `${t.replace(/\/$/, '')}/videos`;
    }
    return t;
  }

  // Bare id or search-ish string: treat an 11-char id as a video, else error out
  // rather than silently searching (a wrong-video ingest is expensive to notice).
  if (/^[\w-]{11}$/.test(t)) return `https://www.youtube.com/watch?v=${t}`;

  throw new Error(
    `Unrecognized target "${target}". Use @handle, a channel/playlist/video URL, or an 11-char video id.`,
  );
}

export function targetKindHint(target) {
  const value = String(target).trim();
  if (/^[\w-]{11}$/.test(value) || /youtu\.be\/|youtube\.com\/watch\?/i.test(value)) return 'video';
  if (/youtube\.com\/playlist\?|[?&]list=/i.test(value)) return 'playlist';
  if (/^@|youtube\.com\/(?:@|c\/|channel\/|user\/)/i.test(value)) return 'channel';
  return 'unknown';
}

export function entryAvailability(entry) {
  if (!entry) return 'unavailable';
  if (entry.availability && entry.availability !== 'needs_auth') return entry.availability;
  const title = String(entry.title || '').toLowerCase();
  if (title.includes('private video')) return 'private';
  if (title.includes('deleted video') || title.includes('removed video')) return 'removed';
  if (title.includes('unavailable video') || title === '[unavailable]') return 'unavailable';
  if (entry.availability === 'needs_auth') return 'restricted';
  return entry.id ? 'public' : 'unavailable';
}

// Stage 1 — enumerate without extracting. Returns { kind, channel, entries[] }.
// entries: [{ id, title, duration, url }]. upload_date is deliberately NOT read
// here: the flat listing omits or approximates it. Real dates come from stage 2.
export function listTarget(target, { limit } = {}) {
  const url = normalizeTarget(target);
  const args = ['--no-update', '--flat-playlist', '-J', '--ignore-errors'];
  if (limit && Number(limit) > 0) args.push('--playlist-end', String(Number(limit)));
  args.push(url);

  const { stdout, stderr, status } = run(args, { allowFailure: true, authenticated: true });
  if (!stdout.trim()) {
    if (status !== 0 && /private|sign.?in|login|cookie|authentication/i.test(stderr)) {
      throw new Error(`YouTube authentication blocked for ${url}: configure YT_COOKIES_FILE or refresh the exported cookies.`);
    }
    throw new Error(`yt-dlp returned no data for ${url}`);
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`yt-dlp returned non-JSON for ${url}: ${stdout.slice(0, 300)}`);
  }

  // A single video URL yields a video object, not a playlist.
  if (data._type !== 'playlist' && data.id) {
    return {
      kind: 'video',
      channel: data.channel || data.uploader || 'Unknown',
      channelId: data.channel_id || null,
      title: data.title || null,
      playlistId: null,
      entries: [{
        id: data.id, title: data.title, duration: data.duration, url,
        position: 1, availability: entryAvailability(data),
        channel: data.channel || data.uploader || null,
      }],
    };
  }

  const entries = (data.entries || []).map((e, index) => ({
    id: e?.id ?? null,
    title: e?.title || '(unavailable)',
    duration: e?.duration ?? null,
    url: e?.url || (e?.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
    position: Number(e?.playlist_index) || index + 1,
    availability: entryAvailability(e),
    channel: e?.channel || e?.uploader || null,
  }));

  return {
    kind: targetKindHint(target) === 'channel' ? 'channel' : 'playlist',
    title: data.title || null,
    playlistId: data.id || null,
    channel: data.channel || data.uploader || data.title || 'Unknown',
    channelId: data.channel_id || null,
    entries,
  };
}

// Stage 2 — fetch metadata + subtitles for specific ids in ONE process.
// Writes <outDir>/<id>.info.json and <outDir>/<id>.<lang>.vtt.
// Returns { status, stderr } so the caller can report partial failures honestly.
export function fetchVideos(ids, outDir, { since, transcript = true } = {}) {
  if (!ids.length) return { status: 0, stderr: '' };

  const args = [
    '--no-update',
    '--skip-download',
    '--write-info-json',
    '--no-playlist',            // ids are explicit; never expand a mix playlist
    '--ignore-errors',          // one dead video must not kill the batch
    '--no-warnings',
    '--sleep-requests', String(SLEEP_REQUESTS_S),
    '-o', join(outDir, '%(id)s.%(ext)s'),
  ];

  // Subtitle flags are the expensive part (one request per track per video), so
  // --no-transcript must genuinely omit them, not just ignore the result.
  if (transcript) {
    args.push(
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', SUB_LANGS,
      '--sub-format', 'vtt',
    );
  }
  if (since) args.push('--dateafter', String(since).replace(/-/g, ''));
  for (const id of ids) args.push(`https://www.youtube.com/watch?v=${id}`);

  const { stderr, status } = run(args, { allowFailure: true, authenticated: true });
  return { status, stderr };
}

// Read a fetched info.json, tolerating absence (video failed extraction).
export function readInfoJson(outDir, id) {
  const p = join(outDir, `${id}.info.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Pick the best available .vtt for an id, honoring SUB_LANG_PREFERENCE.
// Returns { lang, text } or null when the video has no English captions at all.
export function readBestSubtitle(outDir, id) {
  let files;
  try {
    files = readdirSync(outDir);
  } catch {
    return null;
  }

  const available = new Map();
  for (const f of files) {
    const m = f.match(new RegExp(`^${id}\\.([\\w-]+)\\.vtt$`));
    if (m) available.set(m[1], join(outDir, f));
  }
  if (available.size === 0) return null;

  const lang =
    SUB_LANG_PREFERENCE.find((l) => available.has(l)) ?? [...available.keys()][0];

  try {
    return { lang, text: readFileSync(available.get(lang), 'utf8') };
  } catch {
    return null;
  }
}
