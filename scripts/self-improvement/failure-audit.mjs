#!/usr/bin/env node
// Failure-mode audit over Claude Code transcripts (~/.claude/projects/**/*.jsonl).
// Theo's method: count user CORRECTIONS per model, classify them, surface the top
// incidents, then write rules from recurring classes (>=2 independent sessions).
//
// Usage: node scripts/self-improvement/failure-audit.mjs [--days 30] [--out file.md] [--json file.json]
// Read-only over transcripts. Writes only --out/--json. Output stays repo-local
// (docs/self-improvement/audits) because it contains session text.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(opt('--days', 30));
const OUT = opt('--out', null);
const JSON_OUT = opt('--json', null);
const DUMP = opt('--dump', null);
const dumpRows = [];
const ROOT = path.join(os.homedir(), '.claude', 'projects');
const since = Date.now() - DAYS * 864e5;

// Correction classes: [id, label, regex on the lowercased human message]. First match wins.
const CLASSES = [
  ['scope', 'overbuild / did more than asked / unasked edits', /\b(didn'?t ask|did not ask|too much|over ?engineer|overbuilt|unasked|i only (wanted|asked)|just (wanted|asked) you to|scope creep|why did you (change|edit|touch|add))\b/],
  ['wrong_target', 'wrong file / branch / process / project', /\b(wrong (file|branch|project|repo|directory|folder|process|session|machine)|not that (file|one)|that'?s the wrong|in the wrong)\b/],
  ['no_verify', 'claimed done without evidence / did not check', /\b(did you (actually|even) (run|test|check|verify)|didn'?t (run|test|check|verify)|not verified|you claimed|prove it|show me the (output|evidence)|it'?s not (working|fixed)|still (broken|failing|not working))\b/],
  ['misread', 'misread the request / answered a different question', /\b(that'?s not what i (asked|meant|said)|not what i (asked|meant|want)|you misunderstood|misread|i said|re-?read (my|the) (message|request|prompt))\b/],
  ['stopped_early', 'stopped early / incomplete / asked instead of doing', /\b(why did you stop|you stopped|finish (it|the task|what you started)|don'?t stop|keep going|just do it|stop asking|don'?t ask|you didn'?t finish)\b/],
  ['regression', 'broke something that worked', /\b(you broke|broke (the|my|it)|regress(ed|ion)|used to work|was working before|undo (that|this)|revert (that|this|your))\b/],
  ['format', 'output format / verbosity / style', /\b(too (long|verbose|wordy)|shorter|be concise|too many words|em ?dash|next steps block|format(ting)? (is|was) wrong|plain text|don'?t use (blockquote|markdown))\b/],
  ['tool_misuse', 'wrong tool / command / platform mistake', /\b(use (powershell|bash) instead|don'?t use (that|the) (tool|command)|wrong (tool|command)|python3|that command (doesn'?t|won'?t) work)\b/],
  ['generic_no', 'bare negation: "no," / "wrong" / "stop"', /^(no[,.!\s]|nope|wrong[,.!\s]|that'?s wrong|incorrect|not right|stop[,.!\s])/],
];

// Text that the harness injects as a "user" turn. Only needed for transcripts older than the
// origin metadata below; newer ones say who wrote the turn.
const INJECTED_PREFIX = /^(<local-command|<system-reminder|<command-name>|<task-notification|Base directory for this skill|This session is being continued|Caveat: The messages below)/;

const isHuman = (o) => {
  if (o.type !== 'user' || !o.message || o.message.role !== 'user') return false;
  if (o.isSidechain) return false; // subagent-internal turns
  // Headless `claude -p` runs (scheduled pipelines) are prompts a script wrote, not Dave.
  if (o.entrypoint === 'sdk-cli') return false;
  // Meta flags first: skill loads, /loop prompts and compact summaries are never Dave, even
  // if a record also carries a human origin.
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return false;
  // Authoritative when present: 'human' for typed/queued turns; 'task-notification', 'peer',
  // 'scheduled' and 'sdk' for everything the harness injects.
  if (o.origin && o.origin.kind) return o.origin.kind === 'human';
  if (o.turnOrigin) return o.turnOrigin === 'human';
  const c = o.message.content;
  if (typeof c === 'string') return c.length > 0 && !INJECTED_PREFIX.test(c.trimStart());
  if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return false;
    const t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return t.length > 0 && !INJECTED_PREFIX.test(t.trimStart());
  }
  return false;
};
const textOf = (o) => {
  const c = o.message.content;
  if (typeof c === 'string') return c;
  return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs >= since) files.push(p);
  }
})(ROOT);

const perModel = {};
const incidents = [];
const sessionsByClass = {};
let sessions = 0, humanMsgs = 0;

for (const f of files) {
  const project = path.basename(path.dirname(f));
  const session = path.basename(f, '.jsonl');
  const rl = readline.createInterface({ input: fs.createReadStream(f, 'utf8'), crlfDelay: Infinity });
  let model = 'unknown', lastAssistant = '', seen = false;
  for await (const line of rl) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'assistant' && o.message?.model && !o.isSidechain) {
      model = o.message.model;
      const t = (o.message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      if (t) lastAssistant = t.slice(0, 300);
      continue;
    }
    if (!isHuman(o)) continue;
    const text = textOf(o).trim();
    if (!text || text.length < 3) continue;
    seen = true; humanMsgs++;
    const m = (perModel[model] ||= { userMsgs: 0, corrections: 0, byClass: {} });
    m.userMsgs++;
    if (DUMP) dumpRows.push({ ts: o.timestamp, project, session: session.slice(0, 8), model, prev: lastAssistant.slice(0, 200).replace(/\s+/g, ' '), text: text.slice(0, 400).replace(/\s+/g, ' ') });
    const low = text.slice(0, 600).toLowerCase();
    for (const [id, label, re] of CLASSES) {
      if (re.test(low)) {
        m.corrections++; m.byClass[id] = (m.byClass[id] || 0) + 1;
        (sessionsByClass[id] ||= new Set()).add(session);
        incidents.push({ ts: o.timestamp, project, session, model, cls: id, label, text: text.slice(0, 240).replace(/\s+/g, ' '), prev: lastAssistant.replace(/\s+/g, ' ') });
        break;
      }
    }
  }
  if (seen) sessions++;
}

const rows = Object.entries(perModel).sort((a, b) => b[1].userMsgs - a[1].userMsgs);
const per100 = (m) => (m.userMsgs ? (100 * m.corrections / m.userMsgs).toFixed(1) : '0');
const classTotals = {};
for (const [, m] of rows) for (const [c, n] of Object.entries(m.byClass)) classTotals[c] = (classTotals[c] || 0) + n;

let md = `# Failure-mode audit, last ${DAYS} days\n\n`;
md += `Generated ${new Date().toISOString()} by \`scripts/self-improvement/failure-audit.mjs\`. Read-only over \`~/.claude/projects/**/*.jsonl\`.\n`;
md += `Files ${files.length}. Sessions with human turns ${sessions}. Human messages ${humanMsgs}. Corrections ${incidents.length}.\n\n`;
md += `**Method.** Human turns exclude headless (sdk-cli) prompts, task notifications, skill loads and other injected text, using the transcript's origin metadata where present. A "correction" is a human message that matches one of ${CLASSES.length} regex classes (first match wins). The classes are a candidate pre-filter for human labeling, not a classifier: they were brainstormed, not observed, and they miss polite corrections. This is a heuristic, not ground truth. Expect false positives (a "no" that answers a question) and misses (polite corrections). A class with **2 or more independent sessions** is a rule candidate. A singleton is provisional.\n\n`;
md += `## Corrections per 100 human messages, by model\n\n| Model | Human msgs | Corrections | per 100 |\n|---|---|---|---|\n`;
for (const [k, m] of rows) md += `| ${k} | ${m.userMsgs} | ${m.corrections} | ${per100(m)} |\n`;
md += `\n## By class\n\n| Class | Meaning | Total | Sessions | Rule candidate? |\n|---|---|---|---|---|\n`;
for (const [id, label] of CLASSES) {
  const n = classTotals[id] || 0, s = sessionsByClass[id]?.size || 0;
  md += `| ${id} | ${label} | ${n} | ${s} | ${s >= 2 ? 'yes' : n ? 'provisional' : '-'} |\n`;
}
md += `\n## Class x model\n\n| Class | ${rows.map(([k]) => k).join(' | ')} |\n|---|${rows.map(() => '---').join('|')}|\n`;
for (const [id] of CLASSES) md += `| ${id} | ${rows.map(([, m]) => m.byClass[id] || 0).join(' | ')} |\n`;
md += `\n## Incidents (most recent 80; text truncated; ref = project/session)\n\n`;
incidents.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
for (const i of incidents.slice(0, 80)) {
  md += `- **${i.cls}** | ${i.model} | ${i.ts?.slice(0, 10)} | \`${i.project}/${i.session.slice(0, 8)}\`\n  - user: ${i.text}\n  - before: ${i.prev.slice(0, 160) || '(none)'}\n`;
}
md += `\n## Next\n\nRead the incidents for each "yes" class. Confirm they are real corrections. Propose ONE rule edit per class with a bad/good pair. Keep this file repo-local: it contains session text.\n`;

if (OUT) fs.writeFileSync(OUT, md); else process.stdout.write(md);
if (DUMP) fs.writeFileSync(DUMP, dumpRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ days: DAYS, files: files.length, sessions, humanMsgs, perModel, classTotals, incidents }, null, 1));

// --dump <file>: write every human turn (model, prev assistant snippet, text) as JSONL so an
// LLM pass can classify corrections. Regex above is the cheap first pass; this is the real one.
