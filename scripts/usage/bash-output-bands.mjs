#!/usr/bin/env node
// bash-output-bands.mjs: how big Bash/PowerShell results are, from local Claude Code transcripts. Zero dependencies.
// Usage: node scripts/usage/bash-output-bands.mjs [--days N] [--format md|json] [--out <file>] [--root <dir>]
//
// Baseline for docs/self-improvement/proposals/2026-10-10-context-mode.md (steal D, and the size of steal A).
// Bands are by characters the model saw: small < 5K, mid 5K-30K, large >= 30K inline (only possible when
// bashOutputMaxChars is raised), persisted (Claude Code saved the output to a file and returned a preview).
// Ways the numbers can be wrong, and how each is handled:
//  1. A persisted result is only a ~2 KB preview, so it looks small. It is classified from
//     toolUseResult.persistedOutputPath, else from the <persisted-output> marker in the text. The original
//     size comes from toolUseResult.persistedOutputSize, else from "Output too large (39.1KB)".
//  2. A resumed session repeats old tool results in a second file. De-dup by tool_use_id across files.
//  3. Main vs subagent comes from the PATH, as in token-report.mjs.
//  4. A failed command (is_error) is counted apart; Claude Code persists only successful output.
//  5. Re-reads of a saved file: a Read whose file_path, or a Bash/PowerShell command whose text, names the
//     saved file's basename. Matched after all files are read, so file order does not matter.
//  6. The window uses the LINE timestamp of the tool result. File mtime is only a prefilter.
//  7. The tool name comes from the tool_use with the same id. A result with no known tool_use is counted.
//  8. A file read through the shell (`cat f`, `sed -n 1,80p f`) is not a dump: the agent wanted the content.
//     Such commands are flagged read-equivalent and kept out of steal A's pool.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DAY_MS, parseLine, isSubagentPath, discoverFiles, textOf, fmt } from './token-report.mjs';

export const SMALL = 5000;
export const INLINE_CEILING = 30000;
const SHELLS = new Set(['Bash', 'PowerShell']);
const TWO_WORD = new Set(['git', 'gh', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'docker', 'cargo', 'go', 'dotnet', 'kubectl', 'az', 'uv', 'pip']);
const READ_HEADS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'less', 'Get-Content', 'gc', 'type', 'echo', 'printf']);
const PERSIST_RE = /^<persisted-output>\s*Output too large \(([\d.]+)\s*(B|KB|MB)\)\. Full output saved to: (.+?)\s*$/m;

/** Band for a successful, non-persisted result of n characters. */
export const bandOf = (n) => (n < SMALL ? 'small' : n < INLINE_CEILING ? 'mid' : 'large');

/** Persist info for one result: {path, originalChars} or null. Structured field first, then the text marker. */
export function persistInfo(text, toolUseResult) {
  const r = toolUseResult && typeof toolUseResult === 'object' ? toolUseResult : null;
  if (r && r.persistedOutputPath) {
    return { path: r.persistedOutputPath, originalChars: Number(r.persistedOutputSize) || 0 };
  }
  const m = typeof text === 'string' && text.startsWith('<persisted-output>') ? text.match(PERSIST_RE) : null;
  if (!m) return null;
  const mult = { B: 1, KB: 1024, MB: 1024 * 1024 }[m[2]];
  return { path: m[3], originalChars: Math.round(Number(m[1]) * mult) };
}

// A leading statement that only sets up the real command: `cd x &&`, `X=1;`, `mkdir -p d &&`.
const SETUP_RE = /^(?:(?:cd|pushd|Set-Location)\s+(?:"[^"]*"|'[^']*'|\S+)|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)|mkdir\s+-p\s+(?:"[^"]*"|'[^']*'|\S+))\s*(?:&&|;)\s*/i;

/** Command head: drops setup statements, env assignments, sudo/timeout; keeps a subcommand for git, npm and so on. */
export function commandHead(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return '?';
  let s = cmd.trim();
  for (let m = s.match(SETUP_RE); m; m = s.match(SETUP_RE)) s = s.slice(m[0].length);
  const words = s.split(/\s+/);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  while (words.length && /^(sudo|env|time|nice)$/.test(words[0])) words.shift();
  if (words[0] === 'timeout') words.splice(0, words[1] && /^\d/.test(words[1]) ? 2 : 1);
  if (!words.length) return '?';
  const first = path.basename(words[0].replace(/^["']|["';|&]+$/g, '')).replace(/\.exe$/i, '');
  const second = words[1] && !words[1].startsWith('-') ? words[1].replace(/[;|&]+$/, '') : '';
  return TWO_WORD.has(first) && second ? `${first} ${second}` : first;
}

/** True when every statement just prints files or text (cat, sed -n, head, Get-Content, echo) with no pipe. */
export function isReadEquivalent(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  let s = cmd.trim();
  for (let m = s.match(SETUP_RE); m; m = s.match(SETUP_RE)) s = s.slice(m[0].length);
  const parts = s.split(/\s*(?:&&|;|\n)\s*/).filter(Boolean);
  return parts.length > 0 && parts.every((seg) => !/\|/.test(seg) && READ_HEADS.has(commandHead(seg))
    && (commandHead(seg) !== 'sed' || /(^|\s)-n\b/.test(seg)));
}

// ---------- state and ingestion ----------
const emptyThread = () => ({
  results: 0, errors: 0, errorChars: 0, inputChars: 0,
  bands: { small: { n: 0, chars: 0 }, mid: { n: 0, chars: 0 }, large: { n: 0, chars: 0 } },
  readEquivalentBig: { n: 0, chars: 0 },
  persisted: { n: 0, originalChars: 0, previewChars: 0 },
});

export function createState(cutoffMs) {
  return {
    cutoffMs, seenResult: new Set(), toolUses: new Map(),
    threads: { main: emptyThread(), sub: emptyThread() },
    heads: new Map(), persistedFiles: new Map(), reads: [],
    q: { lines: 0, filesMain: 0, filesSub: 0, filesOlderThanWindow: 0, parseErrors: 0, dupResults: 0,
      unknownTool: 0, outsideWindow: 0, noTimestamp: 0 },
  };
}

function ingestAssistant(st, o) {
  const c = o.message && o.message.content;
  if (!Array.isArray(c)) return;
  for (const b of c) if (b && b.type === 'tool_use' && b.id) st.toolUses.set(b.id, { name: b.name, input: b.input || {} });
}

function ingestResult(st, o, b, ctx) {
  if (st.seenResult.has(b.tool_use_id)) return void st.q.dupResults++;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (isNaN(ts)) return void st.q.noTimestamp++;
  if (ts < st.cutoffMs) return void st.q.outsideWindow++;
  const use = st.toolUses.get(b.tool_use_id);
  if (!use) return void st.q.unknownTool++;
  st.seenResult.add(b.tool_use_id);
  const text = textOf(b.content);
  if (use.name === 'Read') {
    st.reads.push({ thread: ctx.thread, target: String(use.input.file_path || ''), chars: text.length });
    return;
  }
  if (!SHELLS.has(use.name)) return;
  const cmd = String(use.input.command || '');
  st.reads.push({ thread: ctx.thread, target: cmd, chars: text.length });
  const t = st.threads[ctx.thread];
  t.results++;
  t.inputChars += cmd.length;
  if (b.is_error === true) { t.errors++; t.errorChars += text.length; return; }
  const p = persistInfo(text, o.toolUseResult);
  const head = commandHead(cmd);
  const readEq = isReadEquivalent(cmd);
  const h = st.heads.get(head) || { n: 0, chars: 0, mid: 0, readEquivalent: 0, persisted: 0, originalChars: 0 };
  h.n++; h.chars += text.length; if (readEq) h.readEquivalent++;
  if (p) {
    t.persisted.n++; t.persisted.originalChars += p.originalChars; t.persisted.previewChars += text.length;
    h.persisted++; h.originalChars += p.originalChars;
    st.persistedFiles.set(path.basename(p.path.replace(/\\/g, '/')), { thread: ctx.thread });
  } else {
    const band = bandOf(text.length);
    t.bands[band].n++; t.bands[band].chars += text.length;
    if (band !== 'small') { h.mid++; if (readEq) { t.readEquivalentBig.n++; t.readEquivalentBig.chars += text.length; } }
  }
  st.heads.set(head, h);
}

/** Ingest one raw line. ctx: {thread}. */
export function processLine(st, line, ctx) {
  st.q.lines++;
  const p = parseLine(line);
  if (p.kind === 'parseError') return void st.q.parseErrors++;
  if (p.kind !== 'ok') return;
  const o = p.obj;
  if (!o || typeof o !== 'object' || !o.message) return;
  if (o.type === 'assistant') return ingestAssistant(st, o);
  if (o.type !== 'user' || !Array.isArray(o.message.content)) return;
  for (const b of o.message.content) if (b && b.type === 'tool_result' && b.tool_use_id) ingestResult(st, o, b, ctx);
}

export async function processFile(st, file) {
  const thread = isSubagentPath(file) ? 'sub' : 'main';
  st.q[thread === 'main' ? 'filesMain' : 'filesSub']++;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) processLine(st, line, { thread });
}

// ---------- aggregation ----------
/** Re-reads: Read or shell calls that name a saved file's basename. */
export function matchRereads(st) {
  const out = { main: { n: 0, chars: 0 }, sub: { n: 0, chars: 0 } };
  if (!st.persistedFiles.size) return out;
  const names = [...st.persistedFiles.keys()];
  for (const r of st.reads) {
    const target = r.target.replace(/\\/g, '/');
    if (names.some((n) => target.includes(n))) { out[r.thread].n++; out[r.thread].chars += r.chars; }
  }
  return out;
}

export function aggregate(st, { days, nowMs }) {
  const rereads = matchRereads(st);
  const threads = {};
  for (const k of ['main', 'sub']) {
    const t = st.threads[k], ps = t.persisted, rr = rereads[k];
    threads[k] = { ...t, rereads: rr,
      stealAPoolChars: t.bands.mid.chars + t.bands.large.chars - t.readEquivalentBig.chars,
      persistNetSavedChars: ps.originalChars - ps.previewChars - rr.chars,
      inlineChars: t.bands.small.chars + t.bands.mid.chars + t.bands.large.chars + ps.previewChars + t.errorChars };
  }
  const heads = [...st.heads.entries()].map(([head, v]) => ({ head, ...v }))
    .sort((a, b) => b.chars - a.chars).slice(0, 15);
  return {
    generatedAt: new Date(nowMs).toISOString(), windowDays: days,
    windowFrom: new Date(st.cutoffMs).toISOString(), windowTo: new Date(nowMs).toISOString(),
    bands: { smallBelow: SMALL, inlineCeiling: INLINE_CEILING }, threads, topHeads: heads, dataQuality: { ...st.q },
  };
}

export async function buildReport({ root, days = 7, nowMs = Date.now() }) {
  const cutoffMs = nowMs - days * DAY_MS;
  const st = createState(cutoffMs);
  const q = { q: { filesOlderThanWindow: 0 } };
  const files = discoverFiles(root, cutoffMs, q);
  st.q.filesOlderThanWindow = q.q.filesOlderThanWindow;
  for (const f of files) await processFile(st, f);
  return aggregate(st, { days, nowMs });
}

// ---------- rendering ----------
const share = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');

export function renderMarkdown(r) {
  const L = [];
  L.push(`# Bash/PowerShell output bands: last ${r.windowDays} days`);
  L.push(`Window ${r.windowFrom} to ${r.windowTo} (by line timestamp). Characters the model saw; chars/4 is a low token estimate.`, '');
  L.push('| thread | results | small <5K | mid 5-30K | large >=30K inline | persisted | errors | command chars |', '|---|---|---|---|---|---|---|---|');
  for (const [k, t] of Object.entries(r.threads)) {
    const b = t.bands;
    L.push(`| ${k} | ${t.results} | ${b.small.n} / ${fmt(b.small.chars)} | ${b.mid.n} / ${fmt(b.mid.chars)} | ${b.large.n} / ${fmt(b.large.chars)} | ${t.persisted.n} / ${fmt(t.persisted.previewChars)} | ${t.errors} / ${fmt(t.errorChars)} | ${fmt(t.inputChars)} |`);
  }
  L.push('', 'Cells are count / characters. Persisted characters are the previews the model saw.', '');
  L.push('## Native flood net (persisted output)');
  for (const [k, t] of Object.entries(r.threads)) {
    const p = t.persisted;
    L.push(`- ${k}: ${p.n} saved, ${fmt(p.originalChars)} original, ${fmt(p.previewChars)} preview, ${t.rereads.n} re-reads (${fmt(t.rereads.chars)}). Net kept out of context: ${fmt(t.persistNetSavedChars)}.`);
  }
  const T = r.threads, bigAll = T.main.bands.mid.chars + T.main.bands.large.chars + T.sub.bands.mid.chars + T.sub.bands.large.chars;
  const readAll = T.main.readEquivalentBig.chars + T.sub.readEquivalentBig.chars;
  const poolAll = T.main.stealAPoolChars + T.sub.stealAPoolChars;
  const inlineAll = T.main.inlineChars + T.sub.inlineChars;
  L.push('', `## Steal A's pool: ${fmt(poolAll)} of ${fmt(inlineAll)} inline characters (${share(poolAll, inlineAll)})`);
  L.push(`Inline results of 5K or more total ${fmt(bigAll)}; ${fmt(readAll)} of that is read-equivalent (cat, sed -n, head with no pipe) and is excluded.`, '');
  L.push('## Top command heads by characters seen', '| head | calls | chars | 5K+ inline | read-equivalent calls | persisted | original chars persisted |', '|---|---|---|---|---|---|---|');
  for (const h of r.topHeads) L.push(`| \`${h.head}\` | ${h.n} | ${fmt(h.chars)} | ${h.mid} | ${h.readEquivalent} | ${h.persisted} | ${fmt(h.originalChars)} |`);
  const q = r.dataQuality;
  L.push('', '## Data quality');
  L.push(`- files: ${q.filesMain} main, ${q.filesSub} subagent, ${q.filesOlderThanWindow} skipped by mtime; lines ${q.lines}`);
  L.push(`- duplicate results ${q.dupResults}, unknown tool ${q.unknownTool}, outside window ${q.outsideWindow}, no timestamp ${q.noTimestamp}, parse errors ${q.parseErrors}`);
  return L.join('\n') + '\n';
}

// ---------- CLI ----------
export function parseCli(argv) {
  const { values } = parseArgs({ args: argv, options: {
    days: { type: 'string', default: '30' }, format: { type: 'string', default: 'md' },
    out: { type: 'string' }, root: { type: 'string', default: path.join(os.homedir(), '.claude', 'projects') } } });
  const days = Number(values.days);
  if (!Number.isFinite(days) || days <= 0 || days > 36500) throw new Error(`--days must be a positive number up to 36500, got "${values.days}"`);
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
