// The trace of one engine run: what the reviewer read and searched, built from the cursor-agent stream-json output.
// buildTrace and condense are pure. writeTraceFiles writes <runId>.trace.json, <runId>.condensed.md and <runId>.stream.jsonl.gz beside the record.
// Stream shape (fixtures/cursor-review/stream-json-read-glob.jsonl): one JSON object per line. A tool call is two lines with the same call_id,
// {type:'tool_call', subtype:'started'|'completed', tool_call:{<name>ToolCall:{args, result?}, startedAtMs, completedAtMs?}}. A read result holds
// success.readRange {startLine, endLine} and success.totalLines; a failed call holds result.error.
// Only readToolCall and globToolCall are seen in a real stream so far. grepToolCall reads {pattern, glob} the same way; check a real grep line before trusting it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createToolTracker } from '../cursor-review.mjs';

const MESSAGE_MAX = 1500;
const TOOL_MAX = 500;
const ENTRIES_MAX = 160;
const ERROR_MAX = 300;
const VERSION_FOLDER = /[\\/]versions[\\/](\d{4}\.\d{1,2}\.\d{1,2}[^\\/]*)[\\/]/;

const sha256 = (text) => createHash('sha256').update(String(text ?? '')).digest('hex');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} [cut ${s.length - n} more characters]` : s);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** sha256 of the CONTEXT.md text the reviewer got. */
export const contextSha = sha256;

/**
 * The cursor-agent version. The Windows agent path holds its version folder (.../versions/2026.10.22-27dcf5f/index.js): no process starts.
 * Any other agent runs `--version` once. null when neither works. run is injected for tests.
 */
export function cursorAgentVersion(agent, { run = spawnSync } = {}) {
  for (const part of [agent?.cmd, ...(agent?.prefixArgs ?? [])]) {
    const m = VERSION_FOLDER.exec(String(part ?? ''));
    if (m) return m[1];
  }
  try {
    const r = run(agent.cmd, [...(agent.prefixArgs ?? []), '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const text = r?.status === 0 ? String(r.stdout ?? '').trim() : '';
    return text === '' ? null : text.split(/\r?\n/)[0];
  } catch { return null; }
}

// ---------- paths ----------

const fwd = (p) => String(p).replaceAll('\\', '/');
const trimEnd = (p) => p.replace(/\/+$/, '');
const sameCase = (a, b) => (/^[a-z]:/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * A path relative to the review tree, with forward slashes. prefixes: the tree folders (any slash form). A path outside every prefix stays
 * absolute (forward slashes). A prefix matches only at a folder boundary.
 */
export function relPath(p, prefixes = []) {
  const s = fwd(p);
  for (const raw of prefixes) {
    const pf = trimEnd(fwd(raw ?? ''));
    if (pf === '') continue;
    if (sameCase(s.slice(0, pf.length), pf) && s[pf.length] === '/') return s.slice(pf.length + 1);
    if (sameCase(s, pf)) return '.';
  }
  return s.replace(/^\.\//, '');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes every tree prefix (either slash form) from a free-text string. */
function scrub(text, prefixes) {
  let out = String(text);
  for (const raw of prefixes) {
    if (!raw) continue;
    const plain = String(raw).replace(/[\\/]+$/, '');
    const forms = new Set([plain, fwd(raw).replace(/\/+$/, ''), plain.replaceAll('\\', '\\\\')]);
    // The folder, then one separator: a slash, a backslash, or two backslashes (a backslash inside JSON text).
    for (const f of forms) out = out.replace(new RegExp(`${escapeRe(f)}(?:\\\\\\\\|[\\\\/])?`, 'gi'), '');
  }
  return out;
}

// ---------- the stream ----------

/** The JSON objects of a stream, in order. A line that is not JSON is skipped. */
function parseEvents(raw) {
  const out = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try { const o = JSON.parse(line); if (isObject(o)) out.push(o); } catch { /* not a JSON line */ }
  }
  return out;
}

const kindOf = (tc) => Object.keys(tc ?? {}).find((k) => k.endsWith('ToolCall') && isObject(tc[k]));

/** One record per call_id, in order of first sight: { id, name, args, result, done }. */
function toolCalls(events) {
  const byId = new Map();
  for (const ev of events) {
    if (ev.type !== 'tool_call' || !isObject(ev.tool_call)) continue;
    const kind = kindOf(ev.tool_call);
    if (!kind) continue;
    const id = String(ev.call_id ?? ev.tool_call.toolCallId ?? byId.size);
    const body = ev.tool_call[kind];
    const rec = byId.get(id) ?? { id, name: kind.slice(0, -'ToolCall'.length), args: {}, result: undefined, done: false };
    rec.args = isObject(body.args) ? body.args : rec.args;
    if (ev.subtype === 'completed') { rec.done = true; rec.result = body.result; }
    byId.set(id, rec);
  }
  return [...byId.values()];
}

/** The error text of a finished call, or null. A finished call with a result and no success is an error. */
function errorOf(call) {
  const r = call.result;
  if (!call.done || !isObject(r)) return null;
  if (r.error !== undefined) return clip(typeof r.error === 'string' ? r.error : (r.error?.message ?? JSON.stringify(r.error)), ERROR_MAX).replace(/ \[cut.*$/, '');
  return r.success === undefined ? clip(JSON.stringify(r), ERROR_MAX).replace(/ \[cut.*$/, '') : null;
}

const argPath = (a) => a.path ?? a.filePath ?? a.file ?? a.target_file ?? null;

/** [start, end] of a read, from the result, else the offset and limit, else the line count, else null. */
function rangeOf(call) {
  const ok = isObject(call.result?.success) ? call.result.success : {};
  const rr = ok.readRange;
  if (isObject(rr) && Number.isFinite(rr.startLine) && Number.isFinite(rr.endLine)) return [rr.startLine, rr.endLine];
  const offset = Number(call.args.offset);
  if (Number.isFinite(offset) && call.args.offset !== null && call.args.offset !== undefined) {
    const limit = Number(call.args.limit);
    return [offset, Number.isFinite(limit) && limit > 0 ? offset + limit - 1 : (Number.isFinite(ok.totalLines) ? ok.totalLines : offset)];
  }
  return Number.isFinite(ok.totalLines) && ok.totalLines > 0 ? [1, ok.totalLines] : null;
}

function readsOf(calls, prefixes) {
  const files = new Map();
  for (const c of calls.filter((x) => x.name === 'read' && errorOf(x) === null)) {
    const p = argPath(c.args);
    if (typeof p !== 'string') continue;
    const rel = relPath(p, prefixes);
    const entry = files.get(rel) ?? { path: rel, ranges: [] };
    const range = rangeOf(c);
    if (range && !entry.ranges.some(([a, b]) => a === range[0] && b === range[1])) entry.ranges.push(range);
    files.set(rel, entry);
  }
  return [...files.values()];
}

function errorsOf(calls, prefixes) {
  return calls.flatMap((c) => {
    const message = errorOf(c);
    if (message === null) return [];
    const p = argPath(c.args);
    return [{ tool: c.name, path: typeof p === 'string' ? relPath(p, prefixes) : null, message: scrub(message, prefixes) }];
  });
}

function statsOf(raw, given) {
  if (isObject(given)) return given;
  const tracker = createToolTracker();
  tracker.feed(String(raw ?? ''));
  tracker.flush();
  return tracker.stats();
}

/** The tree folders a path in the stream can start with: the given tree and the cwd the agent reported. */
function prefixesOf(events, treeDir) {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  return [...new Set([treeDir, init?.cwd].filter((x) => typeof x === 'string' && x !== ''))];
}

/**
 * The trace of one run. raw: the stream-json stdout. treeDir: the review tree the agent ran in.
 * meta: { runId, pr, headSha, engineSha, promptSha256, contextSha, model, cursorAgentVersion, durationMs, toolStats?, funnel, findings, diffFiles }.
 * findings are the record findings ({ id, severity, file, startLine, confidence, ... }); only id, sev, path, line and confidence are kept.
 */
export function buildTrace({ raw, treeDir, ...meta }) {
  const events = parseEvents(raw);
  const prefixes = prefixesOf(events, treeDir);
  const calls = toolCalls(events);
  const byTool = {};
  for (const c of calls) byTool[c.name] = (byTool[c.name] ?? 0) + 1;
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  return {
    runId: meta.runId, pr: meta.pr, headSha: meta.headSha, engineSha: meta.engineSha ?? null, promptSha256: meta.promptSha256, contextSha: meta.contextSha ?? null,
    model: meta.model, streamModel: init?.model ?? null, cursorAgentVersion: meta.cursorAgentVersion ?? null,
    filesRead: readsOf(calls, prefixes),
    greps: calls.filter((c) => c.name === 'grep').map((c) => ({ pattern: c.args.pattern ?? c.args.query ?? null, glob: c.args.glob ?? null })),
    globs: calls.filter((c) => c.name === 'glob').map((c) => ({ glob: c.args.globPattern ?? c.args.pattern ?? c.args.glob ?? null })),
    toolErrors: errorsOf(calls, prefixes),
    toolStats: { ...statsOf(raw, meta.toolStats), byTool },
    durationMs: meta.durationMs ?? null, funnel: meta.funnel ?? null,
    findings: (meta.findings ?? []).map((f) => ({ id: f.id, sev: f.severity, path: f.file, line: f.startLine ?? null, confidence: f.confidence ?? null })),
    diffFiles: meta.diffFiles ?? [],
  };
}

// ---------- the condensed view ----------

function brief(value, prefixes) {
  const text = JSON.stringify(value, (k, v) => (k === 'content' && typeof v === 'string' ? `<${v.length} chars>` : v));
  // The tree path also sits in object keys (a grep result is keyed by the tree folder) and, in JSON text, with doubled backslashes.
  return scrub(text ?? '', prefixes);
}

function callLine(c, prefixes) {
  const err = errorOf(c);
  const p = argPath(c.args);
  let target;
  if (c.name === 'read' && typeof p === 'string') {
    const range = rangeOf(c);
    target = `${relPath(p, prefixes)}${range ? ` [${range[0]}-${range[1]}]` : ''}`;
  } else if (c.name === 'glob') target = String(c.args.globPattern ?? c.args.pattern ?? '');
  else if (c.name === 'grep') target = `${c.args.pattern ?? ''}${c.args.glob ? ` in ${c.args.glob}` : ''}`;
  else target = brief(c.args, prefixes);
  const outcome = err !== null ? `ERROR ${scrub(err, prefixes)}` : (c.done ? `ok ${brief(c.result?.success, prefixes).slice(0, 200)}` : 'no result');
  return clip(`- ${err !== null ? 'ERROR ' : ''}TOOL ${c.name} ${scrub(target, prefixes)} => ${outcome}`, TOOL_MAX);
}

const textOf = (ev) => (ev.message?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('');

/**
 * A short Markdown timeline of a stream for a judge: messages (cut at 1,500 characters), tool calls (cut at 500), at most 160 entries.
 * A failed tool call starts with "ERROR". opts: { treeDir }.
 */
export function condense(raw, { treeDir } = {}) {
  const events = parseEvents(raw);
  const prefixes = prefixesOf(events, treeDir);
  const calls = new Map(toolCalls(events).map((c) => [c.id, c]));
  const entries = [];
  const shown = new Set();
  let thinking = '';
  const flush = () => { if (thinking.trim()) entries.push(`- THINK ${clip(scrub(thinking.trim(), prefixes), MESSAGE_MAX)}`); thinking = ''; };
  for (const ev of events) {
    if (ev.type === 'thinking') { if (ev.subtype === 'delta') thinking += ev.text ?? ''; continue; }
    flush();
    if (ev.type === 'assistant') { const t = textOf(ev); if (t.trim()) entries.push(`- AGENT ${clip(scrub(t.trim(), prefixes), MESSAGE_MAX)}`); } else if (ev.type === 'tool_call' && ev.subtype === 'completed') {
      const c = calls.get(String(ev.call_id ?? ev.tool_call?.toolCallId));
      if (c && !shown.has(c.id)) { shown.add(c.id); entries.push(callLine(c, prefixes)); }
    }
  }
  flush();
  for (const c of calls.values()) if (!shown.has(c.id)) entries.push(callLine(c, prefixes));
  const errors = entries.filter((e) => e.startsWith('- ERROR')).length;
  const kept = entries.slice(0, ENTRIES_MAX);
  if (entries.length > kept.length) kept.push(`- ... cut: ${entries.length - kept.length} more entries`);
  return ['# Condensed trace', '', `Entries: ${entries.length}. Tool errors: ${errors}.`, '', ...kept, ''].join('\n');
}

// ---------- files ----------

/** Writes <runId>.trace.json, <runId>.condensed.md and (when the stream is not empty) <runId>.stream.jsonl.gz into dir. Returns the paths. */
export function writeTraceFiles({ dir, runId, trace, raw, condensed }) {
  mkdirSync(dir, { recursive: true });
  const files = { trace: path.join(dir, `${runId}.trace.json`), condensed: path.join(dir, `${runId}.condensed.md`), stream: path.join(dir, `${runId}.stream.jsonl.gz`) };
  writeFileSync(files.trace, `${JSON.stringify(trace, null, 2)}\n`);
  writeFileSync(files.condensed, condensed);
  if (String(raw ?? '') !== '') writeFileSync(files.stream, gzipSync(Buffer.from(raw, 'utf8')));
  return files;
}
