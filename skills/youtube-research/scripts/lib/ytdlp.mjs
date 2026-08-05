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
import { join } from 'node:path';
import {
  YTDLP_EXE, YTDLP_TIMEOUT_MS, SUB_LANGS, SUB_LANG_PREFERENCE, SLEEP_REQUESTS_S,
  INSECURE_TLS,
} from './config.mjs';

function run(args, { timeout = YTDLP_TIMEOUT_MS, allowFailure = false } = {}) {
  // YT_INSECURE_TLS=1 is an EXPLICIT opt-in for sandboxes behind a
  // TLS-intercepting proxy whose CA yt-dlp's bundled trust store lacks.
  // Prefer fixing trust instead: SSL_CERT_FILE=<system CA bundle> passes
  // through to yt-dlp's Python runtime via the environment.
  if (INSECURE_TLS) args = ['--no-check-certificates', ...args];
  const res = spawnSync(YTDLP_EXE, args, {
    timeout,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024, // channel JSON for a large channel is big
    input: '', // close stdin — never inherit a TTY
  });

  if (res.error) {
    if (res.error.code === 'ENOENT') {
      throw new Error(
        `yt-dlp not found (tried "${YTDLP_EXE}"). Run: node scripts/bootstrap.mjs ` +
        '(downloads the official release) — or install it yourself / set YTDLP_EXE.',
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

// Stage 1 — enumerate without extracting. Returns { kind, channel, entries[] }.
// entries: [{ id, title, duration, url }]. upload_date is deliberately NOT read
// here: the flat listing omits or approximates it. Real dates come from stage 2.
export function listTarget(target, { limit } = {}) {
  const url = normalizeTarget(target);
  const args = ['--no-update', '--flat-playlist', '-J', '--ignore-errors'];
  if (limit && Number(limit) > 0) args.push('--playlist-end', String(Number(limit)));
  args.push(url);

  const { stdout, stderr } = run(args, { allowFailure: true });
  return parseListOutput(stdout, stderr, url);
}

// Pure — tested. Turns yt-dlp's -J output into { kind, channel, entries[] }, or
// throws with yt-dlp's OWN error text. The trap this guards (hit live on Claude
// web, 2026-08-04): with --ignore-errors a totally-failed extraction exits
// non-zero AND prints the literal string "null" — JSON.parse succeeds, and an
// unguarded `data._type` becomes a property-access crash that swallows the real
// error (there: SSL CERTIFICATE_VERIFY_FAILED from a TLS-intercepting proxy).
export function parseListOutput(stdout, stderr, url) {
  const errTail = (stderr || '').trim().slice(-600);

  if (!stdout.trim()) {
    throw new Error(
      `yt-dlp returned no data for ${url}${errTail ? ` — yt-dlp said: ${errTail}` : ''}`,
    );
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`yt-dlp returned non-JSON for ${url}: ${stdout.slice(0, 300)}`);
  }

  if (!data || typeof data !== 'object') {
    throw new Error(
      `yt-dlp could not extract ${url}${errTail ? ` — yt-dlp said: ${errTail}` : ' (no error detail)'}`,
    );
  }

  // A single video URL yields a video object, not a playlist.
  if (data._type !== 'playlist' && data.id) {
    return {
      kind: 'video',
      channel: data.channel || data.uploader || 'Unknown',
      channelId: data.channel_id || null,
      entries: [{ id: data.id, title: data.title, duration: data.duration, url }],
    };
  }

  const entries = (data.entries || [])
    .filter((e) => e && e.id)
    .map((e) => ({
      id: e.id,
      title: e.title || '(untitled)',
      duration: e.duration ?? null,
      url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
    }));

  return {
    kind: 'playlist',
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

  const { stderr, status } = run(args, { allowFailure: true });
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
