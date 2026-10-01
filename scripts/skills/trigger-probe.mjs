#!/usr/bin/env node
// Skill trigger probe: measures HIT rate and FALSE-FIRE rate of Claude Code's own
// description-based skill routing, so description rewrites can be compared before and after.
//
// For each case it runs ONE fresh headless session, `claude -p --output-format stream-json
// --verbose`, with only the Skill tool available, and reads which Skill tool_use the model
// emitted. It does not ask the model to name a skill: the tool call is the real routing event.
// ANTHROPIC_API_KEY is removed from the child env so the run bills the subscription.
//
// Usage: node scripts/skills/trigger-probe.mjs [--cases scripts/skills/trigger-cases.json]
//            [--limit N] [--out docs/self-improvement/audits/<date>-skill-trigger-<label>.json]
//            [--model <model>] [--dry-run]
// --dry-run prints the commands and spends nothing. A live run spends one subscription turn
// per case; use --limit for a smoke test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

// The Skill tool only: the probe must never run a case's real work (a prompt such as
// "commit what we have so far" would otherwise commit).
// An empty strict MCP config keeps case prompts from calling any MCP tool.
export function emptyMcpConfigPath() {
  const p = path.join(os.tmpdir(), 'trigger-probe-empty-mcp.json');
  fs.writeFileSync(p, JSON.stringify({ mcpServers: {} }));
  return p;
}

export function buildCommand(model, mcpConfig = emptyMcpConfigPath()) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', 'Skill', '--max-turns', '2',
    '--strict-mcp-config', '--mcp-config', mcpConfig.replace(/\\/g, '/'), '--no-session-persistence'];
  if (model) args.push('--model', model);
  return { cmd: 'claude', args };
}

// Skill names, in order, from the stream-json lines of one run.
export function skillsFired(streamText) {
  const fired = [];
  for (const line of streamText.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'assistant') continue;
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'tool_use' && b.name === 'Skill') {
        const s = String(b.input?.skill ?? b.input?.command ?? '').replace(/^\/+/, '');
        if (s) fired.push(s);
      }
    }
  }
  return fired;
}

function runCase(prompt, model) {
  const { cmd, args } = buildCommand(model);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription, not API billing (headless-claude-mcp rule)
  // Prompt goes over stdin: a long multi-line argv on Windows arrived empty (verified 2026-08-19).
  const r = spawnSync(cmd, args, { input: prompt, encoding: 'utf8', timeout: 180000, env, shell: true, cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  // A run that failed (non-zero exit, spawn error, timeout) says nothing about routing: it is an
  // error, not a miss.
  const error = r.error ? r.error.message : (r.status !== 0 ? `exit ${r.status}` : null);
  return { fired: skillsFired(r.stdout || ''), status: r.status, error, stderr: (r.stderr || '').slice(0, 300) };
}

function main(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const CASES = path.resolve(opt('--cases', path.join(here, 'trigger-cases.json')));
  const OUT = opt('--out', null);
  const LIMIT = Number(opt('--limit', 0)) || Infinity;
  const MODEL = opt('--model', null);
  const { cases: all } = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const cases = all.slice(0, LIMIT);

  if (argv.includes('--dry-run')) {
    const { cmd, args } = buildCommand(MODEL);
    for (const c of cases) console.log(`echo ${JSON.stringify(c.prompt)} | ${cmd} ${args.join(' ')}   # expect ${c.expect.join('|')}`);
    console.log(`dry-run: ${cases.length} cases, 0 turns spent`);
    return 0;
  }

  const results = cases.map((c) => {
    const r = runCase(c.prompt, MODEL);
    const hit = !r.error && r.fired.some((s) => c.expect.includes(s));
    const falseFires = r.error ? [] : r.fired.filter((s) => !c.expect.includes(s));
    return { prompt: c.prompt, expect: c.expect, fired: r.fired, hit, falseFires, status: r.status, error: r.error, stderr: r.stderr };
  });
  const ok = results.filter((r) => !r.error);
  const errors = results.length - ok.length;
  const hits = ok.filter((r) => r.hit).length;
  const summary = {
    cases: results.length, answered: ok.length, errors, hits, hitRate: ok.length ? +(hits / ok.length).toFixed(2) : null,
    promptsWithFalseFire: ok.filter((r) => r.falseFires.length).length,
    noSkillFired: ok.filter((r) => !r.fired.length).length,
    ts: new Date().toISOString(),
  };
  console.log(JSON.stringify(summary, null, 1));
  for (const r of results) {
    const tag = r.error ? `ERR (${r.error})` : (r.hit ? 'HIT ' : 'miss');
    console.log(`${tag} fired[${r.fired.join(',') || '-'}] <= ${r.prompt}  (expect ${r.expect.join('|')})`);
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
  return errors ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
