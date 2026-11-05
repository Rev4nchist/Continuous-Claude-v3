// File discovery for session-review: project folders, candidate transcripts, head probe.
import fs from 'node:fs';
import path from 'node:path';

const SKIP_PREFIX = /^\{"type":"(?:file-history-|api-request|bridge-session|session-owner|atis-latch|frame-link|artifact-)/;
const MAX_HEAD = 16 << 20;

/** First timestamp and entrypoint of a transcript, from its head only. */
export function readHead(file) {
  let firstTs = null, entrypoint = null;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    for (let want = 1 << 17; ; want *= 4) {
      const len = Math.min(want, size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      const lines = buf.toString('utf8').split('\n');
      if (len < size) lines.pop(); // the last line may be cut
      for (const line of lines) {
        if (!line || SKIP_PREFIX.test(line)) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (firstTs === null && o.timestamp) firstTs = Date.parse(o.timestamp);
        if (entrypoint === null && o.entrypoint) entrypoint = o.entrypoint;
        if (firstTs !== null && entrypoint !== null) return { firstTs, entrypoint };
      }
      if (len >= size || want >= MAX_HEAD) break;
    }
  } finally { fs.closeSync(fd); }
  if (firstTs === null || Number.isNaN(firstTs)) firstTs = fs.statSync(file).birthtimeMs;
  return { firstTs, entrypoint };
}

/** Every <prefix>* folder under the projects root (worktree folders included). */
export function projectDirs(projectsRoot, prefix) {
  if (!fs.existsSync(projectsRoot)) return [];
  return fs.readdirSync(projectsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => path.join(projectsRoot, e.name));
}

function mainFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(dir, e.name));
}

export function listCandidates(projectsRoot, prefix, cutoffMs) {
  const out = [];
  for (const dir of projectDirs(projectsRoot, prefix)) {
    for (const file of mainFiles(dir)) {
      const st = fs.statSync(file);
      if (st.mtimeMs >= cutoffMs) out.push({ file, sid: path.basename(file, '.jsonl'), mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** Resolve --session <id-or-prefix> to exactly one file. No time filter. */
export function resolveSession(projectsRoot, prefix, id) {
  if (!/^[0-9a-f-]{4,36}$/i.test(id)) throw new Error(`bad session id: ${id}`);
  const hits = [];
  for (const dir of projectDirs(projectsRoot, prefix)) {
    for (const file of mainFiles(dir)) {
      if (path.basename(file).startsWith(id)) hits.push({ file, sid: path.basename(file, '.jsonl'), mtimeMs: fs.statSync(file).mtimeMs });
    }
  }
  if (hits.length === 0) throw new Error(`no transcript matches ${id}`);
  if (hits.length > 1) throw new Error(`${id} matches ${hits.length} transcripts; use a longer prefix`);
  return hits;
}

/** Walk a directory tree and return files whose name matches `test`. Missing directory gives []. */
export function walkFiles(dir, test, limit = 5000) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'tool-results') stack.push(p); } else if (test(e.name)) out.push(p);
    }
  }
  return out;
}
