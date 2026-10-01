#!/usr/bin/env node
// token-report.mjs: token spend report from local Claude Code transcripts. Zero dependencies.
// Usage: node scripts/usage/token-report.mjs [--days N] [--format md|json] [--out <file>] [--root <dir>]
//
// Reads ~/.claude/projects/**/*.jsonl (main files and subagents/ files). Reports tokens, not dollars.
// Ways the numbers can be wrong, and how each is handled:
//  1. One API message is written as several lines (one per content block, streaming snapshots).
//     De-duplicate by message.id and keep the MAX of each usage field.
//  2. A resumed session repeats old lines in a second file. The de-dup map is global across files.
//  3. Assistant line without usage, synthetic model, all-zero usage: skipped and counted.
//  4. Main vs subagent comes from the PATH (a "subagents" segment), not from the isSidechain flag.
//  5. A recently modified file holds old lines. The window uses the LINE timestamp. File mtime
//     is only a prefilter.
//  6. A truncated last line (live session) is counted as a parse error, never thrown.
//  7. message.id missing: fall back to requestId, then uuid, then a per-line key. Counted.
//  8. Tool results and commands: tool_result blocks are never read as user commands.
//     Tool results and events are de-duplicated (tool_use_id, uuid) because resumed files repeat them.
//  9. Subagent totals quoted in parent tool_result text are never read, so nothing is counted twice.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const DAY_MS = 86400000;
export const BIG_BYTES = 20 * 1024;
const LINE_RE = /"type"\s*:\s*"(?:assistant|user|system)"/;
const COMPACT_PREFIX = 'This session is being continued from a previous conversation';

// ---------- path helpers ----------
export const isSubagentPath = (p) => /[\\/]subagents[\\/]/.test(p);
export const projectSlug = (root, file) => path.relative(root, file).split(/[\\/]/)[0] || '?';

// ---------- line parsing ----------
/** Classify one raw JSONL line: empty, ignored (not a message line), parseError, or ok. */
export function parseLine(line) {
  if (!line || !line.trim()) return { kind: 'empty' };
  if (!LINE_RE.test(line)) return { kind: 'ignored' };
  try { return { kind: 'ok', obj: JSON.parse(line) }; } catch { return { kind: 'parseError' }; }
}

/** Pull usage from an assistant line. status is ok, synthetic, noUsage or zero. */
export function extractUsage(o) {
  const m = o && o.message;
  if (!m) return { status: 'noUsage' };
  const model = m.model || 'unknown';
  if (model === '<synthetic>') return { status: 'synthetic' };
  const u = m.usage;
  if (!u || typeof u !== 'object') return { status: 'noUsage' };
  const usage = { input: u.input_tokens || 0, cw: u.cache_creation_input_tokens || 0,
    cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 };
  if (usage.input + usage.cw + usage.cr + usage.out === 0) return { status: 'zero' };
  return { status: 'ok', model, usage };
}

/** De-dup key. Returns {key, fallback}. fallback is true when message.id was missing. */
export function messageKey(o, anonKey) {
  if (o.message && o.message.id) return { key: `msg:${o.message.id}`, fallback: false };
  if (o.requestId) return { key: `req:${o.requestId}`, fallback: true };
  if (o.uuid) return { key: `uuid:${o.uuid}`, fallback: true };
  return { key: `anon:${anonKey}`, fallback: true };
}

/** Merge usage copies of one message: MAX per field. Mutates and returns prev. */
export function mergeMax(prev, cur) {
  for (const k of Object.keys(prev)) if (cur[k] > prev[k]) prev[k] = cur[k];
  return prev;
}

export function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

/** Slash command name from real user text, or null. tool_result lists never match. */
export function commandOf(content) {
  if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) return null;
  const m = textOf(content).match(/^\s*<command-name>(\/[A-Za-z-]+)<\/command-name>/);
  return m ? m[1] : null;
}

// ---------- state and ingestion ----------
export function createState(cutoffMs) {
  const tools = () => ({ read: 0, grep: 0, readBig: 0, grepBig: 0, bigBytes: 0 });
  return {
    cutoffMs, msgs: new Map(), seenTool: new Set(), seenEvent: new Set(),
    cmds: { clear: 0, compact: 0, compactSummary: 0, boundaryManual: 0, boundaryAuto: 0, boundaryOther: 0 },
    tools: { main: tools(), sub: tools() },
    q: { lines: 0, filesMain: 0, filesSub: 0, filesOlderThanWindow: 0, parseErrors: 0, noUsage: 0, synthetic: 0,
      zeroUsage: 0, idFallback: 0, dupLines: 0, noTimestamp: 0, outsideWindow: 0, sidechainFlagMismatch: 0,
      unknownTool: 0 },
  };
}

function ingestAssistant(st, o, ctx, ts) {
  const m = o.message;
  if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use' && b.id) ctx.toolNames.set(b.id, b.name);
  const r = extractUsage(o);
  if (r.status === 'synthetic') return void st.q.synthetic++;
  if (r.status === 'noUsage') return void st.q.noUsage++;
  if (r.status === 'zero') return void st.q.zeroUsage++;
  const { key, fallback } = messageKey(o, `${ctx.file}:${ctx.lineNo}`);
  const prev = st.msgs.get(key);
  if (prev) {
    st.q.dupLines++;
    mergeMax(prev.usage, r.usage);
    if (!isNaN(ts) && (isNaN(prev.ts) || ts < prev.ts)) prev.ts = ts;
    return;
  }
  if (fallback) st.q.idFallback++;
  st.msgs.set(key, { thread: ctx.thread, model: r.model, usage: { ...r.usage }, ts, sid: o.sessionId || ctx.sid,
    project: ctx.project, agentType: ctx.agentType, effort: o.effort || 'none' });
}

function ingestToolResults(st, content, ctx) {
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || b.type !== 'tool_result' || !b.tool_use_id || st.seenTool.has(b.tool_use_id)) continue;
    st.seenTool.add(b.tool_use_id);
    const name = ctx.toolNames.get(b.tool_use_id);
    if (!name) { st.q.unknownTool++; continue; }
    if (name !== 'Read' && name !== 'Grep') continue;
    const t = st.tools[ctx.thread]; const k = name.toLowerCase();
    const bytes = Buffer.byteLength(textOf(b.content), 'utf8');
    t[k]++;
    if (bytes > BIG_BYTES) { t[`${k}Big`]++; t.bigBytes += bytes; }
  }
}

function ingestUser(st, o, ctx) {
  const c = o.message.content;
  ingestToolResults(st, c, ctx);
  if (ctx.thread !== 'main') return;
  if (o.isCompactSummary === true || (typeof c === 'string' && c.startsWith(COMPACT_PREFIX))) st.cmds.compactSummary++;
  const cmd = commandOf(c);
  if (cmd === '/clear') st.cmds.clear++;
  else if (cmd === '/compact') st.cmds.compact++;
}

function ingestSystem(st, o, ctx) {
  if (o.subtype !== 'compact_boundary' || ctx.thread !== 'main') return;
  const tr = o.compactMetadata && o.compactMetadata.trigger;
  if (tr === 'manual') st.cmds.boundaryManual++; else if (tr === 'auto') st.cmds.boundaryAuto++; else st.cmds.boundaryOther++;
}

/** Ingest one raw line. ctx: {thread, file, lineNo, sid, project, agentType, toolNames}. */
export function processLine(st, line, ctx) {
  st.q.lines++;
  const p = parseLine(line);
  if (p.kind === 'parseError') return void st.q.parseErrors++;
  if (p.kind !== 'ok') return;
  const o = p.obj;
  if (!o || typeof o !== 'object') return;
  if (ctx.thread === 'main' && o.isSidechain === true) st.q.sidechainFlagMismatch++;
  if (ctx.thread === 'sub' && o.isSidechain === false) st.q.sidechainFlagMismatch++;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (o.type === 'assistant' && o.message) return ingestAssistant(st, o, ctx, ts);
  // Events (user lines, system lines) count only inside the window, once per uuid.
  if (isNaN(ts) || ts < st.cutoffMs) return;
  if (o.uuid) { if (st.seenEvent.has(o.uuid)) return; st.seenEvent.add(o.uuid); }
  if (o.type === 'user' && o.message) ingestUser(st, o, ctx);
  else if (o.type === 'system') ingestSystem(st, o, ctx);
}

// ---------- file discovery and reading ----------
export function discoverFiles(root, cutoffMs, st) {
  const out = [];
  const walk = (dir) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        let mt; try { mt = fs.statSync(p).mtimeMs; } catch { continue; }
        if (mt >= cutoffMs) out.push(p); else if (st) st.q.filesOlderThanWindow++;
      }
    }
  };
  walk(root);
  return out.sort((a, b) => Number(isSubagentPath(a)) - Number(isSubagentPath(b)) || a.localeCompare(b)); // main first
}

function agentTypeOf(file) {
  try { return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || 'unknown'; } catch { return 'unknown'; }
}

export async function processFile(st, root, file) {
  const thread = isSubagentPath(file) ? 'sub' : 'main';
  st.q[thread === 'main' ? 'filesMain' : 'filesSub']++;
  const ctx = { thread, file, lineNo: 0, sid: path.basename(file, '.jsonl'), project: projectSlug(root, file),
    agentType: thread === 'sub' ? agentTypeOf(file) : null, toolNames: new Map() };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) { ctx.lineNo++; processLine(st, line, ctx); }
}

// ---------- aggregation ----------
const emptyTok = () => ({ msgs: 0, input: 0, cw: 0, cr: 0, out: 0, total: 0 });
function addTok(t, u) { t.msgs++; t.input += u.input; t.cw += u.cw; t.cr += u.cr; t.out += u.out; t.total += u.input + u.cw + u.cr + u.out; }
const hitRatio = (t) => { const d = t.cr + t.cw + t.input; return d ? t.cr / d : 0; };
const topN = (map, n) => [...map.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.total - a.total).slice(0, n);

/** Build the report object from state. Only messages with a timestamp inside the window count. */
export function aggregate(st, { days, nowMs }) {
  const totals = { main: emptyTok(), sub: emptyTok(), all: emptyTok() };
  const models = new Map(), sessions = new Map(), agents = new Map(), effort = {};
  for (const r of st.msgs.values()) {
    if (isNaN(r.ts)) { st.q.noTimestamp++; continue; }
    if (r.ts < st.cutoffMs) { st.q.outsideWindow++; continue; }
    addTok(totals[r.thread], r.usage); addTok(totals.all, r.usage);
    const bump = (map, k, extra) => { const e = map.get(k) || { ...emptyTok(), ...extra }; addTok(e, r.usage); map.set(k, e); };
    bump(models, r.model); bump(sessions, r.sid, { project: r.project });
    if (r.thread === 'sub') bump(agents, r.agentType || 'unknown');
    effort[r.effort] = (effort[r.effort] || 0) + 1;
  }
  return {
    generatedAt: new Date(nowMs).toISOString(), windowDays: days,
    windowFrom: new Date(st.cutoffMs).toISOString(), windowTo: new Date(nowMs).toISOString(),
    totals, mainShare: totals.all.total ? totals.main.total / totals.all.total : 0,
    cacheHit: { main: hitRatio(totals.main), sub: hitRatio(totals.sub) },
    byModel: topN(models, 50).map(({ key, ...v }) => ({ model: key, ...v })),
    effort,
    topSessions: topN(sessions, 5).map(({ key, ...v }) => ({ sessionId: key, ...v })),
    topAgentTypes: topN(agents, 8).map(({ key, ...v }) => ({ agentType: key, ...v })),
    commands: { ...st.cmds }, bigResults: { thresholdBytes: BIG_BYTES, main: { ...st.tools.main }, sub: { ...st.tools.sub } },
    dataQuality: { ...st.q },
  };
}

export async function buildReport({ root, days = 7, nowMs = Date.now() }) {
  const cutoffMs = nowMs - days * DAY_MS;
  const st = createState(cutoffMs);
  for (const f of discoverFiles(root, cutoffMs, st)) await processFile(st, root, f);
  return aggregate(st, { days, nowMs });
}

// ---------- rendering ----------
export function fmt(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const tokRow = (label, t) => `| ${label} | ${fmt(t.msgs)} | ${fmt(t.input)} | ${fmt(t.cw)} | ${fmt(t.cr)} | ${fmt(t.out)} | ${fmt(t.total)} |`;

export function renderMarkdown(r) {
  const c = r.commands, b = r.bigResults, q = r.dataQuality, T = r.totals;
  const L = [];
  L.push(`# Token report: last ${r.windowDays} days`);
  L.push(`Window ${r.windowFrom} to ${r.windowTo} (by line timestamp). Generated ${r.generatedAt}.`, '');
  L.push('## Totals (tokens)', '| thread | msgs | input | cache write | cache read | output | total |', '|---|---|---|---|---|---|---|');
  L.push(tokRow('main', T.main), tokRow('subagent', T.sub), tokRow('all', T.all));
  L.push(`Share: main ${pct(r.mainShare)}, subagent ${pct(T.all.total ? 1 - r.mainShare : 0)}. Cache hit ratio: main ${pct(r.cacheHit.main)}, subagent ${pct(r.cacheHit.sub)}.`, '');
  L.push('## Tokens by model', '| model | msgs | total | output |', '|---|---|---|---|');
  for (const m of r.byModel.slice(0, 8)) L.push(`| ${m.model} | ${fmt(m.msgs)} | ${fmt(m.total)} | ${fmt(m.out)} |`);
  const eff = Object.entries(r.effort).sort((a, x) => x[1] - a[1]);
  const effN = eff.reduce((a, [, n]) => a + n, 0) || 1;
  L.push('', `## Effort (per message): ${eff.map(([k, n]) => `${k} ${pct(n / effN)}`).join(', ') || 'none'}`, '');
  L.push('## Top 5 sessions', '| session | project | total |', '|---|---|---|');
  for (const s of r.topSessions) L.push(`| ${s.sessionId} | ${s.project} | ${fmt(s.total)} |`);
  L.push('', '## Top subagent types', '| agentType | msgs | total |', '|---|---|---|');
  for (const a of r.topAgentTypes) L.push(`| ${a.agentType} | ${fmt(a.msgs)} | ${fmt(a.total)} |`);
  L.push('', `## Commands: /clear ${c.clear}, /compact ${c.compact}, compactions manual ${c.boundaryManual}, auto ${c.boundaryAuto}, summaries ${c.compactSummary}`, '');
  L.push(`## Big Read/Grep results (over ${b.thresholdBytes / 1024} KB)`);
  for (const [k, t] of [['main', b.main], ['subagent', b.sub]]) L.push(`- ${k}: Read ${t.readBig} of ${t.read}, Grep ${t.grepBig} of ${t.grep}, ${fmt(t.bigBytes)} bytes`);
  L.push('', '## Data quality');
  L.push(`- files: ${q.filesMain} main, ${q.filesSub} subagent, ${q.filesOlderThanWindow} skipped by mtime; lines ${q.lines}`);
  L.push(`- skipped messages: synthetic ${q.synthetic}, no usage ${q.noUsage}, zero usage ${q.zeroUsage}`);
  L.push(`- duplicate lines merged ${q.dupLines}, id fallback ${q.idFallback}, parse errors ${q.parseErrors}`);
  L.push(`- messages outside window ${q.outsideWindow}, no timestamp ${q.noTimestamp}, unknown tool ${q.unknownTool}, sidechain flag mismatch ${q.sidechainFlagMismatch}`);
  return L.join('\n') + '\n';
}

// ---------- CLI ----------
export function parseCli(argv) {
  const { values } = parseArgs({ args: argv, options: {
    days: { type: 'string', default: '7' }, format: { type: 'string', default: 'md' },
    out: { type: 'string' }, root: { type: 'string', default: path.join(os.homedir(), '.claude', 'projects') } } });
  const days = Number(values.days);
  if (!(days > 0)) throw new Error(`--days must be a positive number, got "${values.days}"`);
  if (values.format !== 'md' && values.format !== 'json') throw new Error(`--format must be md or json, got "${values.format}"`);
  return { days, format: values.format, out: values.out, root: values.root };
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseCli(argv); } catch (e) { console.error(e.message); process.exitCode = 2; return; }
  const report = await buildReport({ root: opts.root, days: opts.days });
  const text = opts.format === 'json' ? JSON.stringify(report, null, 2) + '\n' : renderMarkdown(report);
  if (opts.out) { fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true }); fs.writeFileSync(opts.out, text); console.error(`wrote ${opts.out}`); }
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
