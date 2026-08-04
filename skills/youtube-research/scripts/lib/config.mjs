// config.mjs — single source of truth for the YouTube research pipeline.
// ESM, no external deps.
//
// Design note: the on-disk corpus is MECHANICAL — synthesis has to grep across
// transcripts, so the transcript IS the index. No embedding store, no daemon.
//
// PATH CONTRACT (this is the part that matters when running as a plugin):
//   - Code paths resolve relative to THIS module, so every entry script is
//     correct regardless of the cwd it is invoked from.
//   - DATA paths resolve relative to the CURRENT WORKING DIRECTORY, because a
//     plugin is installed once and used across many projects. Writing research
//     output into the plugin's own install directory would be wrong (and on
//     some installs, not writable).
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

// --- code layout (read-only; lives inside the plugin) ------------------------
// scripts/lib -> scripts
export const LIB_ROOT = dirname(fileURLToPath(import.meta.url));
export const YT_ROOT = dirname(LIB_ROOT);

// --- data layout (writable; lives in the user's project) ---------------------
// docs/research/youtube/<channel-slug>/<upload_date>-<video_id>.md   (one video)
// docs/research/youtube/<channel-slug>/_channel.json                 (ingest state)
// docs/research/youtube/_digests/<date>-<slug>.md                    (brief|lab)
// docs/research/youtube/_digests/INDEX.md                            (append-only)
//
// Override with YT_CORPUS_ROOT to point every command at one shared corpus
// (absolute path recommended). A relative override is resolved against cwd.
function resolveCorpusRoot() {
  const override = process.env.YT_CORPUS_ROOT;
  if (override && override.trim()) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  return join(process.cwd(), 'docs', 'research', 'youtube');
}

export const CORPUS_ROOT = resolveCorpusRoot();
export const DIGEST_ROOT = join(CORPUS_ROOT, '_digests');
export const DIGEST_INDEX = join(DIGEST_ROOT, 'INDEX.md');

// Operational state (watchlist, poll logs) is MACHINE DATA, not research output.
// It sits under an underscore-prefixed directory because corpus.mjs:listChannels()
// skips `_`-prefixed dirs — so this can never be mistaken for a channel.
// Override with YT_STATE_ROOT to keep state out of the project tree entirely.
function resolveStateRoot() {
  const override = process.env.YT_STATE_ROOT;
  if (override && override.trim()) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  return join(CORPUS_ROOT, '_state');
}

export const STATE_ROOT = resolveStateRoot();
export const WATCHLIST_PATH = join(STATE_ROOT, 'watchlist.json');
export const LOG_ROOT = join(STATE_ROOT, 'logs');

// --- yt-dlp ------------------------------------------------------------------
// Resolution order: YTDLP_EXE override > a copy installed by bootstrap.mjs
// (<STATE_ROOT>/bin/) > bare `yt-dlp` from PATH. The bootstrapped copy is
// preferred over PATH deliberately: checking PATH here would cost a process
// spawn on every import, and bootstrap.mjs only ever installs when PATH had
// no working yt-dlp. If a PATH install should win later, set YTDLP_EXE=yt-dlp.
function resolveYtdlpExe() {
  if (process.env.YTDLP_EXE) return process.env.YTDLP_EXE;
  const bootstrapped = join(
    STATE_ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
  );
  if (existsSync(bootstrapped)) return bootstrapped;
  return 'yt-dlp';
}
export const YTDLP_EXE = resolveYtdlpExe();

// Hard ceiling per yt-dlp invocation. A channel batch is ONE process, so this
// covers the whole batch, not a single video. Windows stall bugs mean we never
// rely on the tool self-terminating.
export const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 15 * 60 * 1000);

// LESSON (verified 2026-07-25): `--sub-langs "en.*"` globs 30+ machine-translated
// variants (en-ar, en-zh, en-hi, ...) and gets HTTP 429'd partway through. Ask
// for the exact tracks we want and nothing else. Kept to TWO tracks because every
// extra lang is another subtitle request per video — a 25-video batch at 4 langs
// is 100 requests, which is squarely in 429 territory.
// `en-orig` = the creator's original track when the default `en` is a translation.
export const SUB_LANGS = process.env.YT_SUB_LANGS || 'en,en-orig';

// Preference order when a video yields more than one track. The creator's
// original beats an auto-translation.
export const SUB_LANG_PREFERENCE = ['en-orig', 'en', 'en-US', 'en-GB'];

// Politeness delay between yt-dlp requests. Cheap insurance against the 429 that
// the en.* glob triggered; a batch is already only 2 processes.
export const SLEEP_REQUESTS_S = Number(process.env.YT_SLEEP_REQUESTS || 0.75);

// Default cap when a bare @channel is ingested without --limit. Channels can have
// thousands of videos; an unbounded pull is never what someone means.
export const DEFAULT_CHANNEL_LIMIT = 25;

// --- transcript rendering ----------------------------------------------------
// Cues are merged into ~this many characters before a new [MM:SS] stamp is
// emitted. ~220 chars lands around 15-20s of speech: fine-grained enough that a
// citation deep-link drops you within a sentence or two of the claim, coarse
// enough that the transcript stays readable prose rather than a timecode wall.
export const CHUNK_CHARS = Number(process.env.YT_CHUNK_CHARS || 220);

// --- citation ----------------------------------------------------------------
// Every non-obvious claim in a digest must resolve to a clickable, second-accurate
// deep link. This is the whole reason the corpus keeps timestamps.
export function citationUrl(videoId, seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  return `https://youtu.be/${videoId}?t=${t}`;
}

// `[vid:aircAruvnKk @12:04]` — the inline form digests use. Compact, greppable,
// and paired with a link line in the digest's Sources table.
export function citationTag(videoId, seconds) {
  return `[vid:${videoId} @${formatTimestamp(seconds)}]`;
}

// Seconds -> M:SS or H:MM:SS. Used for both display and citation tags.
export function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// Filesystem-safe slug. Used for channel dirs and digest filenames, so it must be
// stable across runs — same input always yields the same slug.
export function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'unknown';
}
