// corpus.mjs — read/write the on-disk YouTube corpus.
// ESM, no external deps.
//
// Layout (one markdown file per video, human-readable and greppable):
//   docs/research/youtube/<channel-slug>/<upload_date>-<video_id>.md
//   docs/research/youtube/<channel-slug>/_channel.json
//
// Every file carries YAML frontmatter for machine reads and a timestamped
// transcript for both human reads and citation. The transcript IS the index —
// no embedding store, no daemon. At corpus sizes below roughly 1,000 videos a
// regex sweep is milliseconds and has zero freshness lag; revisit only if that
// stops being true.
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { CORPUS_ROOT, slugify, formatTimestamp, citationUrl } from './config.mjs';
import { writeJsonAtomic } from './records.mjs';

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function channelDir(channelSlug) {
  return join(CORPUS_ROOT, channelSlug);
}

// --- frontmatter -------------------------------------------------------------
// Deliberately a minimal YAML SUBSET: flat `key: value` only. Values that could
// break the format are JSON-quoted, which YAML parses as a string. Keeping this
// tiny avoids a dependency and a whole class of YAML surprises.
function toYamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return /^[\w.\-/:+]+$/.test(s) && s !== '' ? s : JSON.stringify(s);
}

export function renderFrontmatter(obj) {
  const body = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${toYamlValue(v)}`)
    .join('\n');
  return `---\n${body}\n---\n`;
}

export function parseFrontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: String(text) };

  const meta = {};
  for (const line of m[1].split('\n')) {
    const km = line.match(/^([\w.-]+):\s*(.*)$/);
    if (!km) continue;
    const key = km[1];
    const raw = km[2].trim();
    if (raw === 'null' || raw === '') { meta[key] = null; continue; }
    if (raw === 'true' || raw === 'false') { meta[key] = raw === 'true'; continue; }
    if (raw.startsWith('"')) {
      try { meta[key] = JSON.parse(raw); } catch { meta[key] = raw; }
      continue;
    }
    meta[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return { meta, body: String(text).slice(m[0].length) };
}

// --- video documents ---------------------------------------------------------
const VIDEO_FILE_RE = /^(\d{4}-\d{2}-\d{2}|unknown)-([\w-]{11})\.md$/;

export function listChannels() {
  if (!existsSync(CORPUS_ROOT)) return [];
  return readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
}

export function listVideoFiles(channelSlug) {
  const dir = channelDir(channelSlug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => VIDEO_FILE_RE.test(f))
    .sort()
    .reverse() // newest first
    .map((f) => join(dir, f));
}

export function listVideoEvidenceFiles(channelSlug) {
  const dir = channelDir(channelSlug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.analysis\.json$/.test(name))
    .map((name) => join(dir, name));
}

export function findVideoEvidence(videoId) {
  for (const channel of listChannels()) {
    const match = listVideoEvidenceFiles(channel).find((path) => path.endsWith(`-${videoId}.analysis.json`));
    if (match) return match;
  }
  return null;
}

// Set of video ids already in the corpus for a channel. This is the incremental
// gate: an ingest only fetches ids NOT in here.
export function ingestedIds(channelSlug) {
  const dir = channelDir(channelSlug);
  if (!existsSync(dir)) return new Set();
  const ids = new Set();
  for (const f of readdirSync(dir)) {
    const m = f.match(VIDEO_FILE_RE);
    if (m) ids.add(m[2]);
  }
  return ids;
}

// Corpus-wide id set — used when ingesting a target that spans channels
// (a playlist) so the same video is never stored twice under two channels.
export function allIngestedIds() {
  const ids = new Set();
  for (const ch of listChannels()) {
    for (const id of ingestedIds(ch)) ids.add(id);
  }
  return ids;
}

export function videoFilePath(channelSlug, uploadDate, videoId) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(uploadDate || '') ? uploadDate : 'unknown';
  return join(channelDir(channelSlug), `${date}-${videoId}.md`);
}

// Render one video's markdown document. `chunks` are [{t, text}] from vtt.mjs.
export function renderVideoDoc({ meta, description, chapters, chunks }) {
  const parts = [renderFrontmatter(meta)];

  parts.push(`\n# ${meta.title}\n`);

  const facts = [
    `**Channel:** ${meta.channel}`,
    meta.upload_date && meta.upload_date !== 'unknown' ? `**Uploaded:** ${meta.upload_date}` : null,
    meta.duration ? `**Duration:** ${meta.duration}` : null,
    typeof meta.view_count === 'number' ? `**Views:** ${meta.view_count.toLocaleString('en-US')}` : null,
  ].filter(Boolean).join(' · ');
  parts.push(`${facts}  \n**Watch:** ${meta.url}\n`);

  if (description && description.trim()) {
    // Descriptions are source evidence. Keep the complete creator-authored text;
    // downstream public drafts decide what is relevant and safe to reuse.
    parts.push(`\n## Description\n\n${description.trim()}\n`);
  }

  if (chapters && chapters.length) {
    const rows = chapters.map((c) => {
      const t = formatTimestamp(c.start_time);
      return `- [${t}](${citationUrl(meta.video_id, c.start_time)}) ${c.title}`;
    });
    parts.push(`\n## Chapters\n\n${rows.join('\n')}\n`);
  }

  if (chunks && chunks.length) {
    const lines = chunks.map((c) => `[${formatTimestamp(c.t)}] ${c.text}`);
    parts.push(`\n## Transcript\n\n${lines.join('\n\n')}\n`);
  } else {
    parts.push('\n## Transcript\n\n_No English captions available for this video._\n');
  }

  return parts.join('');
}

export function writeVideoDoc(channelSlug, meta, content) {
  ensureDir(channelDir(channelSlug));
  const p = videoFilePath(channelSlug, meta.upload_date, meta.video_id);
  writeFileSync(p, content, 'utf8');
  return p;
}

export function videoEvidencePath(channelSlug, uploadDate, videoId) {
  return videoFilePath(channelSlug, uploadDate, videoId).replace(/\.md$/, '.analysis.json');
}

export function videoOutlinePath(channelSlug, uploadDate, videoId) {
  return videoFilePath(channelSlug, uploadDate, videoId).replace(/\.md$/, '.outline.md');
}

export function writeVideoEvidence(channelSlug, meta, evidence) {
  ensureDir(channelDir(channelSlug));
  const path = videoEvidencePath(channelSlug, meta.upload_date, meta.video_id);
  writeJsonAtomic(path, evidence);
  return path;
}

export function readVideoDoc(path) {
  const { meta, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  return { path, meta, body };
}

// --- channel state -----------------------------------------------------------
export function channelStatePath(channelSlug) {
  return join(channelDir(channelSlug), '_channel.json');
}

export function readChannelState(channelSlug) {
  const p = channelStatePath(channelSlug);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeChannelState(channelSlug, state) {
  ensureDir(channelDir(channelSlug));
  writeFileSync(channelStatePath(channelSlug), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// --- search ------------------------------------------------------------------
// The point of this function: a hit is not just "this file matched" but a
// CITATION — video id + second offset + clickable deep link. Synthesis reads
// these directly, so a digest's claims are verifiable by construction.
export function searchCorpus(pattern, { channel = null, flags = 'i', limit = 200 } = {}) {
  const re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  const channels = channel ? [channel] : listChannels();
  const hits = [];

  for (const ch of channels) {
    for (const file of listVideoFiles(ch)) {
      const { meta, body } = readVideoDoc(file);
      const tIdx = body.indexOf('## Transcript');
      if (tIdx === -1) continue;

      for (const line of body.slice(tIdx).split('\n')) {
        const lm = line.match(/^\[(\d+:\d{2}(?::\d{2})?)\]\s+(.*)$/);
        if (!lm) continue;
        re.lastIndex = 0;
        if (!re.test(lm[2])) continue;

        const seconds = lm[1].split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
        hits.push({
          channel: ch,
          channelName: meta.channel,
          videoId: meta.video_id,
          title: meta.title,
          uploadDate: meta.upload_date,
          timestamp: lm[1],
          seconds,
          text: lm[2],
          url: citationUrl(meta.video_id, seconds),
          citation: `[vid:${meta.video_id} @${lm[1]}]`,
        });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

// Corpus-wide counts for `/yt status`.
export function corpusStats() {
  const channels = listChannels().map((ch) => {
    const files = listVideoFiles(ch);
    let words = 0;
    let withTranscript = 0;
    let newest = null;
    for (const f of files) {
      const { meta } = readVideoDoc(f);
      words += Number(meta.transcript_words) || 0;
      if (meta.transcript_words) withTranscript += 1;
      if (meta.upload_date && (!newest || meta.upload_date > newest)) newest = meta.upload_date;
    }
    const state = readChannelState(ch);
    return {
      channel: ch,
      name: state?.channelName || ch,
      videos: files.length,
      withTranscript,
      words,
      newestUpload: newest,
      lastIngest: state?.lastIngestAt || null,
    };
  });

  return {
    channels,
    totalVideos: channels.reduce((n, c) => n + c.videos, 0),
    totalWords: channels.reduce((n, c) => n + c.words, 0),
  };
}

export { slugify };

// Sizing guard for stats/size reporting.
export function dirSizeBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    try {
      const s = statSync(join(dir, f));
      if (s.isFile()) total += s.size;
    } catch { /* ignore races */ }
  }
  return total;
}
