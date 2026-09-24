#!/usr/bin/env node
/**
 * rule-router-false-fires.mjs -- the capture log of rules that fired on the wrong command.
 *
 * Capture log: ~/.claude/logs/rule-router-false-fires.jsonl (append-only, one row per capture):
 *   { ts, rule, what, tool, count, reason, source: "review" | "manual", week }
 *
 * Commands:
 *   add --rule <id> --what "<trigger words>" [--note "<why it is wrong>"]   record one by hand
 *   list [--json]                                                          every false fire so far
 *   review [--days 7] [--report <file.md>]                                 judge this week's fires
 *
 * `review` reads the fire log, takes each distinct (rule, trigger words) pair, and asks a headless
 * `claude -p` session (Sonnet, no tools) whether the rule is about that command. Pairs judged
 * "false_fire" are appended to the capture log, and a verdict table is appended to the week's audit
 * report. Exit 1 when the judge call fails, so the scheduled task shows it.
 * Options for tests: --log <fires.jsonl> --capture <false-fires.jsonl> --manifest <manifest.json>
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : dflt);
const logs = join(homedir(), '.claude', 'logs');
const firesPath = opt('--log', join(logs, 'rule-router.jsonl'));
const capturePath = opt('--capture', join(logs, 'rule-router-false-fires.jsonl'));
const manifestPath = opt('--manifest', join(homedir(), '.claude', 'rules-ondemand', 'manifest.json'));
const today = new Date().toISOString().slice(0, 10);

const readJsonl = (p) => (existsSync(p)
  ? readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
  : []);
const capture = (row) => {
  mkdirSync(dirname(capturePath), { recursive: true });
  appendFileSync(capturePath, JSON.stringify({ ts: new Date().toISOString(), week: today, ...row }) + '\n');
};

function list(asJson) {
  const byKey = new Map();
  for (const r of readJsonl(capturePath)) {
    const k = `${r.rule}|${r.what}`;
    const e = byKey.get(k) || { rule: r.rule, what: r.what, count: 0, weeks: new Set(), reasons: new Set(), sources: new Set() };
    e.count += r.count || 1; e.weeks.add(r.week); if (r.reason) e.reasons.add(r.reason); e.sources.add(r.source);
    byKey.set(k, e);
  }
  const rows = [...byKey.values()].sort((a, b) => b.count - a.count)
    .map((e) => ({ ...e, weeks: [...e.weeks].sort(), reasons: [...e.reasons], sources: [...e.sources] }));
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return rows; }
  if (!rows.length) console.log('No false fires captured yet.');
  for (const r of rows) console.log(`${String(r.count).padStart(4)}  ${r.rule}  <-  ${r.what}   (${r.weeks.join(', ')}) ${r.reasons[0] ?? ''}`);
  return rows;
}

/**
 * One line per rule, so the judge knows what each rule is about and what is MEANT to fire it (the
 * "Loads on" column of the always-loaded index, rules/on-demand-rules.md).
 */
function ruleSummaries() {
  const rules = JSON.parse(readFileSync(manifestPath, 'utf8')).rules;
  const dir = dirname(manifestPath);
  let index = '';
  try { index = readFileSync(opt('--index', join(homedir(), '.claude', 'rules', 'on-demand-rules.md')), 'utf8'); } catch { /* optional */ }
  return rules.map((r) => {
    let about = '';
    try {
      about = readFileSync(join(dir, r.files[0]), 'utf8').replace(/^---[\s\S]*?---\s*/, '')
        .split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ').slice(0, 300);
    } catch { /* a missing rule file is judged on its id alone */ }
    const row = index.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${r.files[0]}\``));
    const loadsOn = row ? row.split('|')[2]?.trim() : '';
    return `- ${r.id} (${r.files.join(', ')})${loadsOn ? ` loads on: ${loadsOn}.` : ''} About: ${about}`;
  }).join('\n');
}

function review(days, reportPath) {
  const since = Date.now() - days * 86400000;
  const pairs = new Map();
  for (const f of readJsonl(firesPath).filter((f) => Date.parse(f.ts) >= since)) {
    if (!f.what || /^\$\w+=/.test(f.what)) continue; // old log format: nothing to judge
    for (const rule of f.rules || []) {
      const k = `${rule}|${f.what}`;
      const e = pairs.get(k) || { rule, what: f.what, tool: f.tool, count: 0 };
      e.count++; pairs.set(k, e);
    }
  }
  const items = [...pairs.values()];
  const section = [`\n## False-fire review (${today}, ${items.length} rule and command pairs)\n`];
  if (!items.length) {
    section.push('No fires to judge this week.');
    writeReport(reportPath, section);
    console.log('false-fire review: 0 pairs to judge');
    return 0;
  }
  const prompt = [
    'You audit a hook that loads a rule file when a matching tool call happens. For each fire below,',
    'decide if the rule is genuinely about the command that fired it ("fits") or not ("false_fire").',
    'The trigger words are the first words of the command (a URL or path shows as <arg>), or an agent,',
    'skill or tool name. Rules:', ruleSummaries(), '', 'Fires (rule <- trigger words, tool, count):',
    ...items.map((p, i) => `${i + 1}. ${p.rule} <- "${p.what}" (${p.tool}, x${p.count})`), '',
    'Reply with ONLY a JSON array, one object per fire, in order:',
    '[{"n":1,"verdict":"fits"|"false_fire","reason":"<12 words max>"}]',
  ].join('\n');
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription auth; never API billing for a scheduled judge
  // claude is a real .exe here, so no shell: the prompt goes on stdin, untouched by shell quoting.
  const run = spawnSync('claude', ['-p', '--model', 'sonnet', '--output-format', 'json'], {
    input: prompt, encoding: 'utf8', env, timeout: 300000, maxBuffer: 16 * 1024 * 1024,
  });
  let verdicts;
  try {
    const result = JSON.parse(run.stdout).result;
    verdicts = JSON.parse(result.slice(result.indexOf('['), result.lastIndexOf(']') + 1));
  } catch {
    section.push(`**The judge call failed** (exit ${run.status}). Fires were not judged; re-run \`node scripts/rules/rule-router-false-fires.mjs review\`.`);
    writeReport(reportPath, section);
    console.log(`false-fire review: judge call failed (exit ${run.status}) ${String(run.stderr || '').slice(0, 200)}`);
    return 1;
  }
  let falseFires = 0;
  section.push('| Rule | Trigger words | Count | Verdict | Reason |', '|---|---|---|---|---|');
  items.forEach((p, i) => {
    const v = verdicts.find((x) => x.n === i + 1) || { verdict: 'unjudged', reason: 'missing from the judge reply' };
    if (v.verdict === 'false_fire') {
      falseFires++;
      capture({ rule: p.rule, what: p.what, tool: p.tool, count: p.count, reason: v.reason, source: 'review' });
    }
    section.push(`| ${p.rule} | \`${p.what.replace(/\|/g, '\\|')}\` | ${p.count} | ${v.verdict === 'false_fire' ? '**false fire**' : v.verdict} | ${String(v.reason || '').replace(/\|/g, '/')} |`);
  });
  section.push('', `False fires this week: **${falseFires}**, added to \`${capturePath}\`. All time: \`node scripts/rules/rule-router-false-fires.mjs list\`.`);
  writeReport(reportPath, section);
  console.log(`false-fire review: ${items.length} pairs judged, ${falseFires} false fires captured`);
  return 0;
}

function writeReport(reportPath, lines) {
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, lines.join('\n') + '\n');
}

if (cmd === 'add') {
  const rule = opt('--rule'); const what = opt('--what');
  if (!rule || !what) { console.log('usage: add --rule <id> --what "<trigger words>" [--note "<why>"]'); process.exit(2); }
  capture({ rule, what, tool: opt('--tool', null), count: 1, reason: opt('--note', ''), source: 'manual' });
  console.log(`captured: ${rule} <- ${what}`);
} else if (cmd === 'list') {
  list(rest.includes('--json'));
} else if (cmd === 'review') {
  const report = opt('--report', join(repo, 'docs', 'self-improvement', 'audits', `rule-router-${today}.md`));
  process.exit(review(Number(opt('--days', '7')), report));
} else {
  console.log('usage: rule-router-false-fires.mjs add | list | review   (see the header for options)');
  process.exit(2);
}
