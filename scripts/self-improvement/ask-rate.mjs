#!/usr/bin/env node
// Ask-rate over Claude Code transcripts (~/.claude/projects/<project>/*.jsonl).
// Counts how often a session asks Dave something: AskUserQuestion calls (survey prompts
// dropped) and plain final questions. Both count: the rule can move an ask from the tool into text.
// Denied asks are NOT counted: transcripts do not record permission_denials (0 of the project's
// transcripts carry the key). Read them from the stream-json `result` files of a headless run.
// It is the metric for the "Run the check before you ask" rule in CLAUDE.md.template.
//
// Usage: node scripts/self-improvement/ask-rate.mjs [--days 30] [--project <dir> | --all]
//        [--exclude <sessionPrefix>]... [--root <projects dir>] [--json <file>] [--out <md>]
// --project takes a directory (encoded the way Claude Code names project folders) or a folder
// name under the projects root. Default: the repo this script lives in.
// Read-only over transcripts. Writes only --json/--out.
// --counts: counts only. No session prefixes (top sessions), no project folder name, no exclude list (card coord-seat-counts, part B).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { checkCounts } from './counts-guard.mjs';

const SURVEY = /how did this session go/i;
const NEXT_STEPS = /\n?^#{1,6}\s*Next steps\b[\s\S]*$/im;

export const isSurvey = (question) => SURVEY.test(question || '');

export function endsWithQuestion(text) {
  return /\?["')\]*_`]*\s*$/.test((text || '').replace(NEXT_STEPS, '').trim());
}

// A real human prompt: a user event that is not a tool_result carrier, a sidechain event or a meta line.
function isHumanPrompt(o) {
  if (o.type !== 'user' || o.isSidechain || o.isMeta) return false;
  const c = o.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && c.length > 0 && !c.some((b) => b.type === 'tool_result'));
}

/**
 * Parse one transcript (an array of JSONL lines) into ask counts.
 * Plain questions are counted at turn boundaries: the final assistant text before each human prompt,
 * and the final text of the session. `since` (ms epoch) keeps only events stamped at or after it.
 * `active` says the session has an assistant event in that window.
 */
export function countAsks(lines, since = -Infinity) {
  let entrypoint = null, asks = 0, plainQ = 0, active = false, last = null;
  const closeTurn = () => { if (last?.inWindow && endsWithQuestion(last.text)) plainQ++; last = null; };
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!entrypoint && o.entrypoint) entrypoint = o.entrypoint;
    if (isHumanPrompt(o)) { closeTurn(); continue; }
    if (o.type !== 'assistant' || o.isSidechain || !Array.isArray(o.message?.content)) continue;
    const inWindow = since === -Infinity || Date.parse(o.timestamp) >= since;
    if (inWindow) active = true;
    for (const b of o.message.content) {
      if (inWindow && b.type === 'tool_use' && b.name === 'AskUserQuestion' && !isSurvey(b.input?.questions?.[0]?.question)) asks++;
      if (b.type === 'text' && b.text) last = { text: b.text, inWindow };
    }
  }
  closeTurn();
  return { entrypoint: entrypoint || 'unknown', asks, plainQ, active };
}

const encodeProject = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');

function parseArgs(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const project = opt('--project', path.resolve(here, '..', '..'));
  return {
    days: Number(opt('--days', 30)),
    all: argv.includes('--all'),
    counts: argv.includes('--counts'),
    idRoot: opt('--id-root', null),
    project: fs.existsSync(project) ? encodeProject(project) : project,
    root: opt('--root', path.join(os.homedir(), '.claude', 'projects')),
    exclude: argv.flatMap((a, i) => (a === '--exclude' && argv[i + 1] ? [argv[i + 1]] : [])),
    json: opt('--json', null),
    out: opt('--out', null),
  };
}

async function readLines(file) {
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const l of rl) out.push(l);
  return out;
}

function listTranscripts(cfg, since) {
  const dirs = cfg.all
    ? fs.readdirSync(cfg.root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(cfg.root, e.name))
    : [path.join(cfg.root, cfg.project)];
  return dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d) : []).filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(d, f)).filter((p) => fs.statSync(p).mtimeMs >= since));
}

function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const e = (by[r.entrypoint] ||= { sessions: 0, withAsk: 0, asks: 0, plainQ: 0, top: [] });
    e.sessions++; e.asks += r.asks; e.plainQ += r.plainQ;
    if (r.asks) { e.withAsk++; e.top.push({ session: r.session, asks: r.asks }); }
  }
  for (const e of Object.values(by)) e.top = e.top.sort((a, b) => b.asks - a.asks).slice(0, 3);
  return by;
}

const rate = (n, d) => (d ? Math.round((100 * n) / d) / 100 : 0);

/** Interactive = every entrypoint except headless sdk-cli. The kill criterion reads asksPlusPlainPerSession. */
export function interactiveHeadline(by) {
  const inter = Object.entries(by).filter(([k]) => k !== 'sdk-cli').map(([, e]) => e);
  const sum = (k) => inter.reduce((n, e) => n + e[k], 0);
  const h = { sessions: sum('sessions'), asks: sum('asks'), plainQ: sum('plainQ') };
  return { ...h, asksPerSession: rate(h.asks, h.sessions), asksPlusPlainPerSession: rate(h.asks + h.plainQ, h.sessions) };
}

function render(cfg, by, files, since) {
  const per = (n, d) => (d ? (n / d).toFixed(2) : '0.00');
  const h = interactiveHeadline(by);
  let md = `# Ask rate, last ${cfg.days} days${cfg.counts ? ' (counts only)' : ''}\n\n`;
  md += cfg.counts
    ? `Cutoff ${new Date(since).toISOString()}. Transcripts ${files}.\n\n`
    : `Cutoff ${new Date(since).toISOString()}. Scope ${cfg.all ? 'all projects' : cfg.project}. Excluded session prefixes: ${cfg.exclude.join(', ') || '(none)'}. Transcripts ${files}.\n\n`;
  md += cfg.counts
    ? `| Entrypoint | Sessions | With ask | Asks | Asks/session | Plain final ? |\n|---|---|---|---|---|---|\n`
    : `| Entrypoint | Sessions | With ask | Asks | Asks/session | Plain final ? | Top sessions |\n|---|---|---|---|---|---|---|\n`;
  for (const [k, e] of Object.entries(by)) {
    md += `| ${k} | ${e.sessions} | ${e.withAsk} | ${e.asks} | ${per(e.asks, e.sessions)} | ${e.plainQ} |${cfg.counts ? '' : ` ${e.top.map((t) => `${t.session.slice(0, 8)}:${t.asks}`).join(' ') || '-'} |`}\n`;
  }
  md += `\nAsks per interactive session (entrypoint other than sdk-cli): ${per(h.asks, h.sessions)} (${h.asks} asks, ${h.sessions} sessions).\n`;
  return `${md}Asks plus plain final questions per interactive session: ${per(h.asks + h.plainQ, h.sessions)} (${h.asks} asks, ${h.plainQ} plain, ${h.sessions} sessions).\n`;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const since = Date.now() - cfg.days * 864e5;
  const rows = [];
  const all = listTranscripts(cfg, since);
  for (const f of all) {
    const session = path.basename(f, '.jsonl');
    if (cfg.exclude.some((p) => session.startsWith(p))) continue;
    const row = countAsks(await readLines(f), since);
    if (row.active) rows.push({ session, ...row }); // per-event timestamps: a resumed old session passes the mtime filter alone
  }
  const by = summarize(rows);
  const md = render(cfg, by, rows.length, since);
  const counted = Object.fromEntries(Object.entries(by).map(([k, e]) => [k, { sessions: e.sessions, withAsk: e.withAsk, asks: e.asks, plainQ: e.plainQ }]));
  const jsonText = cfg.json ? JSON.stringify(cfg.counts
    ? { days: cfg.days, since: new Date(since).toISOString(), interactive: interactiveHeadline(by), byEntrypoint: counted }
    : { days: cfg.days, since: new Date(since).toISOString(), exclude: cfg.exclude, interactive: interactiveHeadline(by), byEntrypoint: by }, null, 1) : '';
  if (cfg.counts) { // the final pass: no listed id in a counts output (entrypoint words come from transcripts)
    const g = checkCounts([md, jsonText], cfg.idRoot);
    if (g.line) console.error(g.line);
    if (!g.ok) process.exit(g.code);
  }
  if (cfg.out) fs.writeFileSync(cfg.out, md); else process.stdout.write(md);
  if (cfg.json) fs.writeFileSync(cfg.json, jsonText);
}

const isDirectRun = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) await main();
