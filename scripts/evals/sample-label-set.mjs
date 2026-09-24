#!/usr/bin/env node
/**
 * sample-label-set.mjs — draw a stratified sample of (agent turn -> Dave's reply) pairs for
 * human labeling. Step 2 of the evals plan (2026-09-23 Opus 5.5 eval, P17): judges are only
 * trustworthy once validated against Dave's own PASS/FAIL labels (TPR/TNR on a held-out split).
 *
 * Unit = the agent's last reply before a human turn, plus that human turn. Dave labels the
 * AGENT reply: PASS (it did what he wanted) or FAIL (his reply corrects, repeats or rejects it),
 * with an optional one-line note that later becomes an observed failure category.
 *
 * Human turns use the same filter as scripts/self-improvement/failure-audit.mjs (P08):
 * entrypoint != sdk-cli, not isMeta, origin.kind === 'human' when present.
 * Secret-shaped strings are redacted before anything is written.
 *
 * Usage: node scripts/evals/sample-label-set.mjs [--n 100] [--days 400] [--out sample.json]
 * Deterministic: the same transcripts give the same sample (hash order, no randomness).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt('--n', 100));
const DAYS = Number(opt('--days', 400));
const OUT = opt('--out', null);
const ROOT = path.join(os.homedir(), '.claude', 'projects');
const since = Date.now() - DAYS * 864e5;
const AGENT_CHARS = 1400;
const HUMAN_CHARS = 900;

const INJECTED = /^(\[Request interrupted|<local-command|<system-reminder|<command-name>|<task-notification|Base directory for this skill|This session is being continued|Caveat: The messages below)/;
const SECRET = /(sk-(?:ant|proj)-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+|xox[bpas]-[A-Za-z0-9-]{10,}|-----BEGIN[A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,})/gi;

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
const redact = (s) => s.replace(SECRET, '[REDACTED]');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' …' : s);

function isHuman(o) {
  if (o.type !== 'user' || !o.message || o.message.role !== 'user' || o.isSidechain) return false;
  if (o.entrypoint === 'sdk-cli') return false;
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return false;
  if (o.origin && o.origin.kind) return o.origin.kind === 'human';
  const c = o.message.content;
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  return t.length > 0 && !INJECTED.test(t);
}

const pairs = [];
for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = path.join(ROOT, d.name);
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (!f.endsWith('.jsonl') || fs.statSync(p).mtimeMs < since) continue;
    let lastAgent = '', model = 'unknown';
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'assistant' && !o.isSidechain && o.message) {
        const t = textOf(o.message.content).trim();
        if (t) { lastAgent = t; model = o.message.model || model; }
        continue;
      }
      if (!isHuman(o) || !lastAgent) continue;
      const human = textOf(o.message.content).trim();
      if (human.length < 2) continue;
      pairs.push({
        id: crypto.createHash('sha1').update(`${d.name}/${f}/${o.timestamp}`).digest('hex').slice(0, 12),
        project: d.name.replace(/^C--Users-david-hayes-|^C--/, ''),
        session: f.slice(0, 8), ts: o.timestamp, model,
        agent: redact(clip(lastAgent, AGENT_CHARS)),
        human: redact(clip(human, HUMAN_CHARS)),
      });
      lastAgent = '';
    }
  }
}

// Stratify by project: each project gets a share proportional to its pairs, at least 2 when
// it has any, then fill by a stable hash order so the sample is reproducible.
const byProject = new Map();
for (const p of pairs) (byProject.get(p.project) || byProject.set(p.project, []).get(p.project)).push(p);
const order = (a, b) => a.id.localeCompare(b.id);
const sample = [];
for (const [, list] of byProject) {
  const share = Math.max(2, Math.round((list.length / pairs.length) * N));
  sample.push(...list.sort(order).slice(0, share));
}
sample.sort(order);
const final = sample.slice(0, N).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
const summary = { pairs: pairs.length, sampled: final.length, projects: Object.fromEntries([...byProject].map(([k, v]) => [k, v.length])), redactions: final.filter((p) => /\[REDACTED\]/.test(p.agent + p.human)).length };
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), summary, items: final }, null, 1));
console.log(JSON.stringify(summary));
