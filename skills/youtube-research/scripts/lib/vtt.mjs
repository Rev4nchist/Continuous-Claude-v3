// vtt.mjs — WebVTT -> clean, timestamped transcript chunks.
// ESM, no external deps.
//
// Why this file is not trivial: YouTube auto-generated captions are ROLLING.
// Each cue repeats the previous cue's trailing line(s) so the on-screen text
// scrolls smoothly:
//
//   00:00:01.000 --> 00:00:03.000
//   so the first thing we do
//
//   00:00:03.000 --> 00:00:05.000
//   so the first thing we do
//   is normalize the input
//
// Concatenating cues naively yields ~2x duplicated text, which wrecks synthesis
// (the model sees every sentence twice and over-weights it) and doubles token
// cost. Cues also carry inline karaoke markup — <00:00:04.220><c>word</c> — that
// must be stripped before the text is usable.
import { CHUNK_CHARS } from './config.mjs';

const TIMECODE_RE =
  /^(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})\s+-->\s+(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})/;

function toSeconds(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

// Strip VTT/HTML markup and normalize whitespace. Order matters: tags first
// (they can contain '&'), then entities, then whitespace collapse.
export function stripCueMarkup(line) {
  return String(line)
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const META_RE = /^(WEBVTT|NOTE|STYLE|REGION)\b/;

// Parse a WebVTT document into raw cues: [{ start, end, lines[] }].
// Tolerates cue identifiers, NOTE/STYLE/REGION blocks, and CRLF.
//
// Blocks are split on blank lines because that is what correctly separates an
// optional cue IDENTIFIER from the preceding cue's text. But a cue's payload can
// itself contain a blank line — YouTube normally emits a single space there, yet
// a genuinely empty line is legal and would otherwise orphan the cue's text into
// a timecode-less block and silently drop it. So a cue that parses with EMPTY
// text adopts the following block when that block carries no timecode of its own.
export function parseCues(vttText) {
  const blocks = String(vttText)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.split('\n').filter((l) => l.trim() !== ''))
    .filter((b) => b.length > 0);

  const cues = [];

  for (let i = 0; i < blocks.length; i += 1) {
    const raw = blocks[i];
    if (META_RE.test(raw[0].trim())) continue;

    const idx = raw.findIndex((l) => TIMECODE_RE.test(l.trim()));
    if (idx === -1) continue; // no timecode -> identifier-only or stray block

    const m = raw[idx].trim().match(TIMECODE_RE);
    const start = toSeconds(m[1], m[2], m[3], m[4]);
    const end = toSeconds(m[5], m[6], m[7], m[8]);

    let lines = raw.slice(idx + 1).map(stripCueMarkup).filter((l) => l !== '');

    // Orphaned-payload recovery (see block comment above).
    if (lines.length === 0) {
      const next = blocks[i + 1];
      const nextIsPayload = next
        && !META_RE.test(next[0].trim())
        && !next.some((l) => TIMECODE_RE.test(l.trim()));
      if (nextIsPayload) {
        lines = next.map(stripCueMarkup).filter((l) => l !== '');
        i += 1; // consumed
      }
    }

    if (lines.length > 0) cues.push({ start, end, lines });
  }

  return cues;
}

// Collapse rolling duplication into a linear stream of new lines.
//
// Dedup is deliberately CONSERVATIVE — it compares each cue's lines only against
// the immediately preceding cue's lines (plus the last line actually emitted).
// A wider window would silently drop genuinely repeated phrases ("no. no. no.",
// a repeated chorus, a speaker restating a definition), which is worse than
// leaving an occasional duplicate in: a dropped line is an unciteable claim.
export function dedupeCues(cues) {
  const out = [];
  let prevLines = [];
  let lastEmitted = null;

  for (const cue of cues) {
    const fresh = [];
    for (const line of cue.lines) {
      if (prevLines.includes(line)) continue; // rolling carry-over
      if (line === lastEmitted) continue;     // stutter across cue boundary
      fresh.push(line);
      lastEmitted = line;
    }
    if (fresh.length > 0) out.push({ start: cue.start, end: cue.end, text: fresh.join(' ') });
    prevLines = cue.lines;
  }

  return out;
}

// Merge deduped cues into readable chunks, each stamped with the start time of
// its FIRST cue (so a citation deep-link lands at or just before the claim,
// never after it).
export function chunkCues(cues, { chunkChars = CHUNK_CHARS } = {}) {
  const chunks = [];
  let buf = [];
  let bufLen = 0;
  let start = null;

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({ t: start, text: buf.join(' ').replace(/\s+/g, ' ').trim() });
    buf = [];
    bufLen = 0;
    start = null;
  };

  for (const cue of cues) {
    if (start === null) start = cue.start;
    buf.push(cue.text);
    bufLen += cue.text.length + 1;
    if (bufLen >= chunkChars) flush();
  }
  flush();

  return chunks;
}

// Full pipeline: VTT text -> [{ t: seconds, text }].
export function vttToChunks(vttText, opts = {}) {
  return chunkCues(dedupeCues(parseCues(vttText)), opts);
}

// Render chunks as markdown transcript lines: `[M:SS] text`.
export function renderTranscript(chunks, formatTimestamp) {
  return chunks.map((c) => `[${formatTimestamp(c.t)}] ${c.text}`).join('\n\n');
}

// Rough word count over the deduped text — the honest number, after rolling
// duplication is removed.
export function countWords(chunks) {
  return chunks.reduce((n, c) => n + (c.text.match(/\S+/g)?.length ?? 0), 0);
}
