#!/usr/bin/env node
/**
 * scout-tldr-count -- how often scout runs use the tldr CLI (card coord-search-defaults). Counts only.
 * Design note: .claudedocs/coordination/2026-11-16-coord-search-defaults-design.md section 3. Read-only: it writes nothing and sends nothing.
 * It reads the subagent transcripts of this project and of its worktrees (<projects>/<slug>[--claude-worktrees-*]/<session>/subagents/<agent>.meta.json
 * and .jsonl) and counts, per scout run, the tool calls by tool name and the Bash calls that run tldr, by sub-command. The output holds fixed keys and
 * numbers: no command text, no prompt text, no session id, no file path. A last pass refuses to print when a listed id is in the text (as ask-ledger).
 *
 * Usage: node scripts/agents/scout-tldr-count.mjs [--since <ISO date>] [--dir <one projects folder>] [--root <repo root of the listed-id list>]
 *   --since  count only runs whose transcript was last written at or after this date (the two-week measure of the card)
 *   --dir    read this one folder instead of the project folder and its worktree folders
 * Exit: 0 ok | 1 usage | 2 no scout run in the window | 3 the listed-id list is unreadable or an id reached the output | 4 internal error
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countListed, readIdList } from '../coordination/board-mask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MSG_LIST = 'scout-tldr-count: the listed-id list could not be read; no output';
const MSG_NOTE = 'scout-tldr-count: note: no listed-id list in this root; the output holds only counts';
const MSG_LEFT = 'scout-tldr-count: an id reached the output; no output';
const MSG_INTERNAL = 'scout-tldr-count: internal error; no output';
// Sub-commands that get their own count. Anything else is "other", so no free text reaches the output.
const SUBCOMMANDS = new Set(['structure', 'tree', 'search', 'extract', 'impact', 'importers', 'calls', 'change-impact', 'imports', 'arch', 'dead', 'context', 'semantic', 'diagnostics', 'cfg', 'dfg', 'slice', 'daemon', 'warm']);
// Sub-commands that take --lang. scout.md asks for an explicit --lang on these only (tree takes --ext; search and extract need none).
const LANG_SUBS = new Set(['structure', 'impact', 'calls', 'importers', 'change-impact']);
const TOOLS = ['Grep', 'Glob', 'Read', 'Bash'];
// tldr must be the first word of a segment, after a shell opener (`$(`, `(`, then, do, else, NAME=$( ), env assignments, `timeout N`, `uv run` and a
// folder path. It is not an argument of rg or grep.
const TLDR_SEGMENT = /^\s*(?:(?:\$\(|\(|then\b|do\b|else\b|[A-Za-z_][A-Za-z0-9_]*=\$\()\s*)*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:timeout\s+\d+[smh]?\s+)?(?:uv\s+run\s+)?(?:\S*[\\/])?tldr(?:\.exe)?\s+([a-z][a-z-]*)(.*)$/;
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;

class Usage extends Error {}

function parseArgs(argv) {
  const a = { since: null, dir: null, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--since' || k === '--dir' || k === '--root') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Usage(`${k} needs a value`);
      a[k.slice(2)] = v;
      i += 1;
    } else throw new Usage(`unknown argument ${k}`);
  }
  if (a.since !== null && Number.isNaN(Date.parse(a.since))) throw new Usage('--since is not a date');
  return a;
}

function primaryRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: HERE, encoding: 'utf8' }).trim();
    return path.dirname(common);
  } catch { return path.resolve(HERE, '..', '..'); }
}
const slugOf = (root) => root.replace(/[^A-Za-z0-9]/g, '-');

/** The project folders of the primary checkout and of its worktrees under <projects>. */
export function projectDirs(projects, primary) {
  const slug = slugOf(primary);
  let names = [];
  try { names = fs.readdirSync(projects); } catch { return []; }
  return names.filter((n) => n === slug || n.startsWith(`${slug}--claude-worktrees-`)).map((n) => path.join(projects, n));
}

/** The tldr sub-commands that one Bash command runs, as [{sub, lang}]. Quoted text is blanked; the command is split at ; & | and line ends. */
export function tldrCalls(command) {
  const out = [];
  for (const seg of String(command ?? '').replace(QUOTED, '""').split(/[;&|\n]+/)) {
    const m = TLDR_SEGMENT.exec(seg);
    if (!m) continue;
    out.push({ sub: SUBCOMMANDS.has(m[1]) ? m[1] : 'other', lang: /(?:^|\s)--lang(?:\s|=)/.test(m[2]) });
  }
  return out;
}

/** One transcript: tool calls by name (each tool id once) and the tldr calls in them. */
export function countTranscript(text) {
  const seen = new Set();
  const run = { tools: 0, byTool: { Grep: 0, Glob: 0, Read: 0, Bash: 0, other: 0 }, tldr: [] };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_use' || seen.has(b.id)) continue;
      seen.add(b.id);
      run.tools += 1;
      run.byTool[TOOLS.includes(b.name) ? b.name : 'other'] += 1;
      if (b.name === 'Bash') run.tldr.push(...tldrCalls(b.input?.command));
    }
  }
  return run;
}

/** Every scout run under the folders: {runs: [{tools, byTool, tldr}], unreadable}. A run is a subagent whose meta file says agentType scout. */
export function readScoutRuns(dirs, sinceMs = -Infinity) {
  const runs = [];
  let unreadable = 0;
  for (const dir of dirs) {
    let sessions = [];
    try { sessions = fs.readdirSync(dir); } catch { continue; }
    for (const s of sessions) {
      const sub = path.join(dir, s, 'subagents');
      let names = [];
      try { names = fs.readdirSync(sub); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith('.meta.json')) continue;
        let meta;
        try { meta = JSON.parse(fs.readFileSync(path.join(sub, f), 'utf8')); } catch { continue; }
        if (meta?.agentType !== 'scout') continue;
        const tf = path.join(sub, f.replace(/\.meta\.json$/, '.jsonl'));
        try {
          if (fs.statSync(tf).mtimeMs < sinceMs) continue;
          runs.push(countTranscript(fs.readFileSync(tf, 'utf8')));
        } catch { unreadable += 1; }
      }
    }
  }
  return { runs, unreadable };
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarize({ runs, unreadable = 0 }, since) {
  const bySub = {};
  let toolCalls = 0, tldrCalls = 0, langNeeded = 0, langGiven = 0, runsWithTldr = 0;
  const byTool = { Grep: 0, Glob: 0, Read: 0, Bash: 0, other: 0 };
  for (const r of runs) {
    toolCalls += r.tools;
    for (const k of Object.keys(byTool)) byTool[k] += r.byTool[k];
    if (r.tldr.length) runsWithTldr += 1;
    for (const c of r.tldr) {
      tldrCalls += 1;
      bySub[c.sub] = (bySub[c.sub] || 0) + 1;
      if (LANG_SUBS.has(c.sub)) { langNeeded += 1; if (c.lang) langGiven += 1; }
    }
  }
  return {
    since: since ? new Date(since).toISOString() : null, runs: runs.length, unreadableTranscripts: unreadable, runsWithTldr,
    runsWithTldrPercent: runs.length ? Math.round((1000 * runsWithTldr) / runs.length) / 10 : 0,
    toolCalls, byTool, tldrCalls, tldrBySubcommand: bySub, tldrLangRequired: langNeeded, tldrLangGiven: langGiven,
    medianToolCallsPerRun: median(runs.map((r) => r.tools)),
  };
}

/** True when the text holds no listed id (the last pass before anything is printed). */
export function guardOutput(text, ids) {
  return !(ids && countListed(text, ids) > 0);
}

function run(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) {
    if (!(e instanceof Usage)) throw e;
    process.stderr.write(`scout-tldr-count: ${e.message}\n`);
    return 1;
  }
  const primary = primaryRoot();
  const root = a.root || primary;
  const dirs = a.dir ? [a.dir] : projectDirs(path.join(os.homedir(), '.claude', 'projects'), primary);
  let ids = null;
  try { ids = readIdList(root); } catch (e) {
    if (e && e.kind === 'absent') process.stderr.write(`${MSG_NOTE}\n`);
    else { process.stderr.write(`${MSG_LIST}\n`); return 3; }
  }
  const found = readScoutRuns(dirs, a.since ? Date.parse(a.since) : -Infinity);
  if (!found.runs.length) {
    process.stderr.write(`scout-tldr-count: no scout run in the window since=${a.since || '-'}\n`);
    return 2;
  }
  const text = JSON.stringify(summarize(found, a.since));
  if (!guardOutput(text, ids)) { process.stderr.write(`${MSG_LEFT}\n`); return 3; }
  process.stdout.write(`${text}\n`);
  return 0;
}

// A thrown error would print a stack with full paths: print one fixed line instead.
export function main(argv) {
  try { return run(argv); } catch { process.stderr.write(`${MSG_INTERNAL}\n`); return 4; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
