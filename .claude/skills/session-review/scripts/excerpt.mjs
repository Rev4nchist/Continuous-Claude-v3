#!/usr/bin/env node
// session-review excerpt. Prints a redacted excerpt around one record of a transcript.
// All quotes in a review report come from here. Streams the file; refuses anything outside
// ~/.claude/projects; at most 40 lines of at most 200 characters.
//
// Usage: node excerpt.mjs --session <id-or-prefix> --uuid <record uuid> --context N   (N <= 10)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { redact, oneLine } from './lib/redact.mjs';

const MAX_LINES = 40;
const MAX_CHARS = 200;
const MAX_CONTEXT = 10;
const PREFIX = 'C--Users-dkhay-continuous-claude';

function fail(msg, code = 2) {
  process.stderr.write(`session-review excerpt: ${msg}\n`);
  process.exit(code);
}

function findFile(root, id) {
  if (!/^[0-9a-f-]{4,36}$/i.test(id)) fail(`bad session id: ${id}`);
  const hits = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith(PREFIX)) continue;
    const dir = path.join(root, d.name);
    for (const n of fs.readdirSync(dir)) if (n.endsWith('.jsonl') && n.startsWith(id)) hits.push(path.join(dir, n));
  }
  if (hits.length !== 1) fail(hits.length ? `${id} is ambiguous` : `no transcript matches ${id}`);
  const real = fs.realpathSync(hits[0]);
  const rel = path.relative(fs.realpathSync(root), real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail('file is outside the projects root');
  return real;
}

function blockText(b) {
  if (!b) return '';
  if (b.type === 'text') return b.text || '';
  if (b.type === 'tool_use') return `[tool_use ${b.name}] ${typeof b.input === 'object' ? (b.input.command || b.input.file_path || b.input.pattern || b.input.description || '') : ''}`;
  if (b.type === 'tool_result') return `[tool_result${b.is_error ? ' ERROR' : ''}] ${typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => x.text || '').join(' ') : '')}`;
  return '';
}

/** One redacted line per record, or null for records with no readable text. */
function render(o) {
  let t = '';
  if (o.message && typeof o.message.content === 'string') t = o.message.content;
  else if (o.message && Array.isArray(o.message.content)) t = o.message.content.map(blockText).filter(Boolean).join(' ');
  else if (o.type === 'system') t = `${o.subtype || ''} ${typeof o.content === 'string' ? o.content : ''}`;
  else if (o.type === 'attachment' && o.attachment) t = `${o.attachment.type || ''} ${o.attachment.hookName || ''}`;
  if (!t.trim()) return null;
  const who = o.type === 'user' ? (o.origin && o.origin.kind ? `user/${o.origin.kind}` : 'user') : o.type;
  const line = oneLine(redact(`${who} ${String(o.uuid || '').slice(0, 8)}: ${t}`));
  return line.length > MAX_CHARS ? line.slice(0, MAX_CHARS) : line;
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { session: { type: 'string' }, uuid: { type: 'string' }, context: { type: 'string' } } });
  if (!values.session || !values.uuid) fail('need --session and --uuid');
  const n = values.context === undefined ? 3 : Number(values.context);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CONTEXT) fail(`--context must be an integer 0..${MAX_CONTEXT}`);
  const root = path.join(os.homedir(), '.claude', 'projects');
  const file = findFile(root, values.session);
  const before = [];
  const after = [];
  let found = false;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.trim() || raw.length > 4e6 && !raw.includes(values.uuid)) continue;
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!o || !o.message && o.type !== 'system' && o.type !== 'attachment') continue;
    const line = render(o);
    if (!found) {
      if (o.uuid === values.uuid) { found = true; if (line) after.push(`> ${line}`); }
      else if (line) { before.push(line); if (before.length > n) before.shift(); }
    } else if (line) {
      after.push(line);
      if (after.length > n) break;
    }
  }
  if (!found) fail(`uuid ${values.uuid} not found in ${path.basename(file)}`, 1);
  const out = [...before, ...after].slice(0, MAX_LINES);
  process.stdout.write(out.join('\n') + '\n');
}

main().catch((e) => fail(e && e.message, 2));
