#!/usr/bin/env node
// Skill trigger probe: measures HIT rate and FALSE-FIRE rate for skill routing across BOTH
// trigger channels, so description rewrites can be compared before/after (premortem tigers
// #2-#4: baseline, negatives, runtime not static).
//
//   channel "hook"   = our own UserPromptSubmit hook skill-activation-prompt (skill-rules.json)
//   channel "native" = Claude Code's own description-based router, asked via one `claude -p`
//                      call to name the skill it would invoke for each prompt (no tools).
//
// Usage: node scripts/skills/trigger-probe.mjs [--cases scripts/skills/trigger-cases.json]
//            [--out docs/self-improvement/audits/<date>-skill-trigger-<label>.json] [--skip-native]
// Read-only. Spawns the hook dist and (optionally) one headless claude -p on the subscription.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CASES = path.resolve(opt('--cases', path.join(here, 'trigger-cases.json')));
const OUT = opt('--out', null);
const SKIP_NATIVE = args.includes('--skip-native');
const HOOK = path.join(os.homedir(), '.claude', 'hooks', 'dist', 'skill-activation-prompt.mjs');

const { cases } = JSON.parse(fs.readFileSync(CASES, 'utf8'));

function hookChannel(prompt) {
  const input = JSON.stringify({ session_id: 'trigger-probe', transcript_path: '', cwd: repo, permission_mode: 'default', prompt });
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8', timeout: 30000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const fired = new Set();
  // Lines like "  → skill-name" under RECOMMENDED SKILLS; also "Skill: name" variants.
  // "→ name" = recommended; "• name" = ambiguous match (still surfaced to the model, so counted).
  for (const m of out.matchAll(/(?:→|->|•)\s*([a-z0-9][a-z0-9_:-]*)\s*(?:\\n|$)/gim)) if (m[1] !== 'Skip') fired.add(m[1]);
  return [...fired];
}

function nativeChannel(prompts) {
  const list = prompts.map((p, i) => `${i + 1}. ${p}`).join('\n');
  const ask = `You have a list of available skills in your context. For EACH numbered user prompt below, name the ONE skill you would invoke (exact skill name as listed), or "none" if you would not invoke a skill. Do not call any tools. Do not explain. Reply with ONLY a JSON array like [{"i":1,"skill":"commit"}, ...].\n\n${list}`;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription, not API billing (headless-claude-mcp rule)
  // Prompt goes over stdin: a long multi-line argv on Windows arrived empty (verified 2026-08-19).
  const r = spawnSync('claude', ['-p', '--output-format', 'json', '--max-turns', '1'], { input: ask, encoding: 'utf8', timeout: 300000, env, shell: true, cwd: repo });
  const raw = r.stdout || '';
  let text = raw;
  try { const j = JSON.parse(raw); text = j.result ?? j.content ?? raw; } catch {}
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return { error: 'no-json', raw: String(text).slice(0, 500) };
  try { return { answers: JSON.parse(m[0]) }; } catch (e) { return { error: String(e), raw: m[0].slice(0, 500) }; }
}

const results = [];
let hookHits = 0, hookFalse = 0;
for (const c of cases) {
  const fired = hookChannel(c.prompt);
  const hit = fired.some((s) => c.expect.includes(s));
  const falseFires = fired.filter((s) => !c.expect.includes(s));
  if (hit) hookHits++; if (falseFires.length) hookFalse++;
  results.push({ prompt: c.prompt, expect: c.expect, hook: { fired, hit, falseFires } });
}

let native = null;
if (!SKIP_NATIVE) {
  native = nativeChannel(cases.map((c) => c.prompt));
  if (native.answers) {
    for (const a of native.answers) {
      const r = results[a.i - 1]; if (!r) continue;
      const s = String(a.skill || 'none').replace(/^\/+/, '');
      r.native = { fired: s, hit: r.expect.includes(s), falseFire: s !== 'none' && !r.expect.includes(s) };
    }
  }
}
const nat = results.filter((r) => r.native);
const summary = {
  cases: cases.length,
  hook: { hits: hookHits, hitRate: +(hookHits / cases.length).toFixed(2), promptsWithFalseFire: hookFalse },
  native: nat.length ? { answered: nat.length, hits: nat.filter((r) => r.native.hit).length, hitRate: +(nat.filter((r) => r.native.hit).length / nat.length).toFixed(2), falseFires: nat.filter((r) => r.native.falseFire).length } : (native?.error || 'skipped'),
  ts: new Date().toISOString(),
};
console.log(JSON.stringify(summary, null, 1));
for (const r of results) {
  const h = r.hook.hit ? 'HIT ' : 'miss';
  const n = r.native ? (r.native.hit ? 'HIT ' : `miss(${r.native.fired})`) : '-';
  console.log(`${h} hook[${r.hook.fired.join(',') || '-'}]  native:${n}  <= ${r.prompt}  (expect ${r.expect.join('|')})`);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, results, nativeRaw: native?.raw }, null, 1));
