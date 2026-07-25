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
    // Descriptions are frequently link-spam walls; keep the useful head only.
    const trimmed = description.trim().split('\n').slice(0, 25).join('\n');
    parts.push(`\n## Description\n\n${trimmed}\n`);
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

export function readVideoDoc(path) {
  const { meta, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  return { path, meta, body };
}

// Set project_id on already-ingested videos, in place.
//
// Tagging an existing corpus into a project must NOT mean re-downloading it —
// that would make "drop this channel into project X" cost a full re-ingest to
// change one frontmatter field. Rewrites frontmatter only; the transcript body
// is preserved byte-for-byte, which matters because digests cite into it by
// timestamp. Returns the number of files actually changed (already-correct
// files are left untouched so mtimes stay meaningful).
export function retagVideos(videoIds, projectId) {
  const ids = new Set(videoIds);
  if (ids.size === 0) return 0;
  let changed = 0;

  for (const ch of listChannels()) {
    for (const file of listVideoFiles(ch)) {
      const raw = readFileSync(file, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      if (!ids.has(meta.video_id)) continue;
      if (meta.project_id === projectId) continue;
      meta.project_id = projectId;
      writeFileSync(file, renderFrontmatter(meta) + body, 'utf8');
      changed += 1;
    }
  }
  return changed;
}

// Distinct project ids present in the corpus, for status/discovery.
export function listProjects() {
  const projects = new Map();
  for (const ch of listChannels()) {
    for (const file of listVideoFiles(ch)) {
      const { meta } = readVideoDoc(file);
      if (!meta.project_id) continue;
      const p = projects.get(meta.project_id) ?? { project: meta.project_id, videos: 0, channels: new Set() };
      p.videos += 1;
      p.channels.add(ch);
      projects.set(meta.project_id, p);
    }
  }
  return [...projects.values()]
    .map((p) => ({ ...p, channels: [...p.channels].sort() }))
    .sort((a, b) => b.videos - a.videos);
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
// Parse a video doc's transcript into addressable chunks: [{ t, timestamp, text }].
// This is the retrieval unit — ~240 chars / ~60 tokens on the current corpus.
export function transcriptChunks(body) {
  const tIdx = body.indexOf('## Transcript');
  if (tIdx === -1) return [];
  const chunks = [];
  for (const line of body.slice(tIdx).split('\n')) {
    const lm = line.match(/^\[(\d+:\d{2}(?::\d{2})?)\]\s+(.*)$/);
    if (!lm) continue;
    chunks.push({
      timestamp: lm[1],
      t: lm[1].split(':').reduce((acc, v) => acc * 60 + Number(v), 0),
      text: lm[2],
    });
  }
  return chunks;
}

// Core windowing, as a pure function over parsed chunks so it is testable
// without a corpus on disk.
//
// Returns [{ anchor, from, to, matchCount }] — index positions into `chunks`.
// Adjacent matches whose windows would overlap are MERGED into one group: two
// hits three chunks apart would otherwise return overlapping text twice,
// re-introducing the read amplification this exists to remove.
//
// Each group is anchored at its FIRST match so a citation deep-link lands at or
// before the claim, never after it.
export function searchChunks(chunks, re, window = 2) {
  const win = Math.max(0, Number(window) || 0);

  const matched = [];
  for (let i = 0; i < chunks.length; i += 1) {
    re.lastIndex = 0;
    if (re.test(chunks[i].text)) matched.push(i);
  }
  if (matched.length === 0) return [];

  const groups = [];
  for (const i of matched) {
    const last = groups[groups.length - 1];
    if (last && i - last[last.length - 1] <= win * 2 + 1) last.push(i);
    else groups.push([i]);
  }

  return groups.map((g) => ({
    anchor: g[0],
    from: Math.max(0, g[0] - win),
    to: Math.min(chunks.length - 1, g[g.length - 1] + win),
    matchCount: g.length,
  }));
}

// A hit is not "this file matched" — it is a CITATION (video id + second offset +
// deep link) carrying ENOUGH SURROUNDING TEXT TO USE WITHOUT OPENING THE FILE.
//
// That last clause is the whole point of SI-02. Returning a filename and letting
// the caller read the file cost a measured 14x at the median transcript and 83x at
// the largest (~4,300 / ~25,000 tokens versus ~300 for a ±2 window). The cited
// claim lives in the window either way, so the rest of the read was waste.
//
// Adjacent matches MERGE into one window rather than emitting separately: two hits
// three chunks apart would otherwise return overlapping text twice, re-introducing
// the amplification this exists to remove.
export function searchCorpus(pattern, {
  channel = null,
  project = null,
  flags = 'i',
  limit = 200,
  window = 2,
} = {}) {
  const re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  const channels = channel ? [channel] : listChannels();
  const win = Math.max(0, Number(window) || 0);
  const hits = [];

  for (const ch of channels) {
    for (const file of listVideoFiles(ch)) {
      const { meta, body } = readVideoDoc(file);
      if (project && meta.project_id !== project) continue;

      const chunks = transcriptChunks(body);
      if (chunks.length === 0) continue;

      for (const g of searchChunks(chunks, re, win)) {
        const anchor = chunks[g.anchor];
        const { from, to } = g;
        const slice = chunks.slice(from, to + 1);

        hits.push({
          channel: ch,
          channelName: meta.channel,
          projectId: meta.project_id ?? null,
          videoId: meta.video_id,
          title: meta.title,
          uploadDate: meta.upload_date,
          transcriptSource: meta.transcript_source ?? null,
          timestamp: anchor.timestamp,
          seconds: anchor.t,
          text: anchor.text,
          matchCount: g.matchCount,
          window: slice,
          windowText: slice.map((c) => c.text).join(' '),
          windowFrom: chunks[from].timestamp,
          windowTo: chunks[to].timestamp,
          url: citationUrl(meta.video_id, anchor.t),
          citation: `[vid:${meta.video_id} @${anchor.timestamp}]`,
          file,
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
