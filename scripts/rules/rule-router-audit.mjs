#!/usr/bin/env node
/**
 * rule-router-audit.mjs -- weekly precision audit of the rule-router hook.
 *
 * Reads ~/.claude/logs/rule-router.jsonl (one line per fire) and writes a markdown report:
 *   - totals, and how many first calls per session were blocked (the friction deny-first adds);
 *   - per rule: fires, blocks, injects, sessions, and the trigger words behind them, so a reader can
 *     spot a false fire (a rule that fired on a command it is not about);
 *   - DEDUPE BREAKS: a rule that fired twice for the same session and agent. That is a router
 *     defect, and the script exits 1 so the scheduled task's last result shows it;
 *   - manifest rules that never fired in the window (a dead trigger, or a tool not used).
 *
 * Usage: node scripts/rules/rule-router-audit.mjs [--days 7] [--log <path>] [--manifest <path>] [--out <file.md>]
 * Default --out: docs/self-improvement/audits/rule-router-<YYYY-MM-DD>.md (repo-local, never published).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const days = Number(arg('--days', '7'));
const logPath = arg('--log', join(homedir(), '.claude', 'logs', 'rule-router.jsonl'));
const manifestPath = arg('--manifest', join(homedir(), '.claude', 'rules-ondemand', 'manifest.json'));
const today = new Date().toISOString().slice(0, 10);
const outPath = arg('--out', join(repo, 'docs', 'self-improvement', 'audits', `rule-router-${today}.md`));

const since = Date.now() - days * 86400000;
const fires = existsSync(logPath)
  ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .filter((f) => Date.parse(f.ts) >= since && f.kind !== 'rearm') // a re-arm after /compact is not a fire
  : [];

// One row per (fire, rule): a fire can carry several rules.
const rows = fires.flatMap((f) => (f.rules || []).map((rule) => ({ ...f, rule })));
const byRule = new Map();
for (const r of rows) {
  const e = byRule.get(r.rule) || { fires: 0, deny: 0, inject: 0, sessions: new Set(), words: new Map() };
  e.fires++; e[r.kind === 'deny' ? 'deny' : 'inject']++; e.sessions.add(r.session);
  const w = /^\$\w+=|^$/.test(r.what || '') ? '(not recorded: log format before 2026-09-24)' : r.what;
  e.words.set(w, (e.words.get(w) || 0) + 1);
  byRule.set(r.rule, e);
}

const seen = new Map();
const dedupeBreaks = [];
for (const r of rows) {
  const k = `${r.session}|${r.agent ?? 'main'}|${r.rule}`;
  if (seen.has(k)) dedupeBreaks.push({ rule: r.rule, session: r.session, agent: r.agent ?? 'main', first: seen.get(k), again: r.ts });
  else seen.set(k, r.ts);
}

const sessions = new Set(fires.map((f) => f.session));
const blocksPerSession = [...sessions].map((s) => fires.filter((f) => f.session === s && f.kind === 'deny').length);
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
let manifestIds = [];
let manifestOk = true; // the router cannot work without it, so a missing manifest fails the run
try { manifestIds = JSON.parse(readFileSync(manifestPath, 'utf8')).rules.map((r) => r.id); } catch { manifestOk = false; }
const neverFired = manifestIds.filter((id) => !byRule.has(id));

const L = [];
L.push(`# rule-router audit, ${today} (last ${days} days)`, '');
L.push(`Source: \`${logPath}\`. Fires: **${fires.length}** in **${sessions.size}** sessions ` +
  `(${fires.filter((f) => f.kind === 'deny').length} blocks, ${fires.filter((f) => f.kind === 'inject').length} injects). ` +
  `Blocks per session: median ${median(blocksPerSession)}, max ${Math.max(0, ...blocksPerSession)}.`, '');
L.push(`**Dedupe breaks: ${dedupeBreaks.length}.** ${dedupeBreaks.length ? 'A rule fired twice for the same session and agent: a router defect.' : 'Each rule fired at most once per session and agent.'}`, '');
for (const d of dedupeBreaks) L.push(`- \`${d.rule}\` session ${d.session} agent ${d.agent}: ${d.first}, again ${d.again}`);
if (dedupeBreaks.length) L.push('');
L.push('## Per rule', '', 'Judge each row: do the trigger words fit the rule? A misfit is a false fire; tighten its manifest trigger.', '');
L.push('| Rule | Fires | Blocks | Injects | Sessions | Trigger words (count) |', '|---|---|---|---|---|---|');
for (const [rule, e] of [...byRule].sort((a, b) => b[1].fires - a[1].fires)) {
  const words = [...e.words].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, n]) => `\`${w.replace(/\|/g, '\\|')}\` (${n})`).join(', ');
  L.push(`| ${rule} | ${e.fires} | ${e.deny} | ${e.inject} | ${e.sessions.size} | ${words} |`);
}
L.push('', `## Never fired in the window (${neverFired.length} of ${manifestIds.length})`, '');
L.push(manifestOk ? (neverFired.length ? neverFired.map((id) => `\`${id}\``).join(', ') : 'None.') : `**Manifest not readable at \`${manifestPath}\`: the router loads no rules. This run exits 1.**`);
L.push('', 'A rule here is either unused in the window or has a trigger that never matches; check the second against its tool.', '');

mkdirSync(dirname(outPath), { recursive: true });
// Keep a false-fire review section already in today's report: if a missed 09:07 run starts after
// the 09:20 review (both catch up at logon), the rewrite must not erase the review.
const prior = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
const reviewAt = prior.indexOf('\n## False-fire review');
writeFileSync(outPath, L.join('\n') + (reviewAt >= 0 ? prior.slice(reviewAt) : ''));
console.log(`rule-router audit: ${fires.length} fires, ${sessions.size} sessions, ${dedupeBreaks.length} dedupe breaks, ${neverFired.length} rules never fired -> ${outPath}`);
if (!manifestOk) console.log(`manifest not readable at ${manifestPath}: the rule-router loads no rules`);
process.exit(dedupeBreaks.length || !manifestOk ? 1 : 0);
