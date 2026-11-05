// Handoff YAML copies in thoughts/shared/handoffs/general. Two matches only:
//  - written: the file was saved inside the session span (plus 15 minutes)
//  - resumed: the first prompt says "Resume the handoff" and names the file's slug
import fs from 'node:fs';
import path from 'node:path';
import { redactTruncate } from './redact.mjs';

const WINDOW_AFTER_MS = 15 * 60000;

const stripQuotes = (s) => s.trim().replace(/^["']|["']$/g, '');

export function findHandoffs(repo) {
  const dir = path.join(repo, 'thoughts', 'shared', 'handoffs', 'general');
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.yaml')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const outcome = /^outcome:\s*(\S+)/m.exec(text);
    const goal = /^goal:\s*(.+)$/m.exec(text);
    out.push({ name: n, mtimeMs: fs.statSync(file).mtimeMs, outcome: outcome ? outcome[1] : null, goal: goal ? redactTruncate(stripQuotes(goal[1]), 400) : null });
  }
  return out;
}

export function handoffsFor(list, S) {
  const goals = [];
  let outcome = null;
  if (S.firstTs !== null && S.lastTs !== null) {
    const written = list.filter((h) => h.mtimeMs >= S.firstTs && h.mtimeMs <= S.lastTs + WINDOW_AFTER_MS).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (written) { outcome = written.outcome; if (written.goal) goals.push(written.goal); }
  }
  const slug = S.firstTyped && /Resume the handoff/i.test(S.firstTyped) ? /\]\s*([a-z0-9][a-z0-9-]+):/i.exec(S.firstTyped) : null;
  if (slug) {
    const resumed = list.find((h) => h.name.includes(slug[1]));
    if (resumed && resumed.goal && !goals.includes(resumed.goal)) goals.push(resumed.goal);
  }
  return { goals, outcome };
}
