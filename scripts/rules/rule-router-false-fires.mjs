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
 *   review --print-prompt   print the judge prompt (rule triggers come from the manifest) and stop
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NTN_EXE } from '../project-cards/lib/config.mjs';

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
 * What is MEANT to fire a rule, from its manifest matchers: the patterns the router really tests.
 * Until 2026-10-04 this came from the "Loads on" column of the always-loaded index, which is prose,
 * could drift from the manifest, and cost always-loaded budget to keep precise.
 */
function ruleTriggers(r) {
  const kinds = [['command', 'a command matching'], ['segment', 'a command (quotes kept) matching'],
    ['agent', 'an agent type matching'], ['skill', 'a skill matching'], ['tools', 'a tool name matching']];
  return kinds.filter(([key]) => r[key]?.length)
    .map(([key, label]) => `${label} ${r[key].map((p) => (p === '^' ? 'anything (every call)' : `/${p}/`)).join(' or ')}`)
    .join('; ');
}

/** One line per rule, so the judge knows what each rule is about and what is MEANT to fire it. */
function ruleSummaries() {
  const rules = JSON.parse(readFileSync(manifestPath, 'utf8')).rules;
  const dir = dirname(manifestPath);
  return rules.map((r) => {
    let about = '';
    try {
      about = readFileSync(join(dir, r.files[0]), 'utf8').replace(/^---[\s\S]*?---\s*/, '')
        .split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ').slice(0, 300);
    } catch { /* a missing rule file is judged on its id alone */ }
    const triggers = ruleTriggers(r);
    return `- ${r.id} (${r.files.join(', ')})${triggers ? ` fires on: ${triggers}.` : ''} About: ${about}`;
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
    if (rest.includes('--print-prompt')) { // prompt-only runs never write a report
      console.log(`No fires to judge in the last ${days} day(s): the judge would not be called.`);
      return { code: 0, judged: 0, found: [] };
    }
    section.push('No fires to judge this week.');
    writeReport(reportPath, section);
    console.log('false-fire review: 0 pairs to judge');
    return { code: 0, judged: 0, found: [] };
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
  if (rest.includes('--print-prompt')) { // shows exactly what the judge would see; no claude call, no report
    console.log(prompt);
    return { code: 0, judged: 0, found: [] };
  }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription auth; never API billing for a scheduled judge
  // claude is a real .exe here, so no shell: the prompt goes on stdin, untouched by shell quoting.
  // No tools at all: `--tools ""` removes the built-ins, `--strict-mcp-config` (with no config) loads
  // no MCP servers. The judge only reads the prompt and answers.
  const run = spawnSync('claude', ['-p', '--model', 'sonnet', '--output-format', 'json', '--tools', '', '--strict-mcp-config'], {
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
    return { code: 1, judged: 0, found: [], error: `the judge call failed (exit ${run.status})` };
  }
  let falseFires = 0;
  let newlyCaptured = 0;
  const found = [];
  // One capture per (rule, words) per ISO week: a re-run in the same week must not count a fire twice.
  const window = isoWeek(new Date());
  const already = new Set(readJsonl(capturePath).filter((r) => r.source === 'review' && r.window === window)
    .map((r) => `${r.rule}|${r.what}`));
  section.push('| Rule | Trigger words | Count | Verdict | Reason |', '|---|---|---|---|---|');
  items.forEach((p, i) => {
    const v = verdicts.find((x) => x.n === i + 1) || { verdict: 'unjudged', reason: 'missing from the judge reply' };
    if (v.verdict === 'false_fire') {
      falseFires++;
      found.push({ rule: p.rule, what: p.what, count: p.count, reason: v.reason, source: 'review' });
      if (!already.has(`${p.rule}|${p.what}`)) {
        capture({ rule: p.rule, what: p.what, tool: p.tool, count: p.count, reason: v.reason, source: 'review', window });
        newlyCaptured++;
      }
    }
    section.push(`| ${p.rule} | \`${p.what.replace(/\|/g, '\\|')}\` | ${p.count} | ${v.verdict === 'false_fire' ? '**false fire**' : v.verdict} | ${String(v.reason || '').replace(/\|/g, '/')} |`);
  });
  section.push('', `False fires this week: **${falseFires}**, added to \`${capturePath}\`. All time: \`node scripts/rules/rule-router-false-fires.mjs list\`.`);
  writeReport(reportPath, section);
  console.log(`false-fire review: ${items.length} pairs judged, ${falseFires} false fires found, ${newlyCaptured} newly captured`);
  return { code: 0, judged: items.length, found };
}

/** ISO-8601 week id, e.g. 2026-W39: the review window a capture belongs to. */
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function writeReport(reportPath, lines) {
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, lines.join('\n') + '\n');
}

/**
 * One Notion page per week under Dave's Scratchpad, where he looks on Mondays (his choice,
 * 2026-09-24; a Windows toast did not show). False fires are checkboxes for him to review: the
 * judge's finds plus any a session or Dave recorded during the week.
 */
function publishNotion(parent, days, result, reportPath) {
  const since = Date.now() - days * 86400000;
  const recorded = readJsonl(capturePath).filter((r) => r.source !== 'review' && Date.parse(r.ts) >= since);
  const esc = (s) => String(s ?? '').replace(/[<>]/g, '');
  const boxes = [
    ...result.found.map((f) => `- [ ] **${f.rule}** fired on \`${esc(f.what)}\` (x${f.count}): ${esc(f.reason)}`),
    ...recorded.map((r) => `- [ ] **${r.rule}** fired on \`${esc(r.what)}\`: ${esc(r.reason) || 'no note'} (recorded by ${r.source === 'agent' ? 'a session' : 'you'})`),
  ];
  const status = result.error
    ? `**The review failed: ${result.error}.** Re-run \`node scripts/rules/rule-router-false-fires.mjs review\` in continuous-claude.`
    : `${result.judged} rule and command pairs judged in the last ${days} days. False fires to review: **${boxes.length}**.`;
  const md = [
    `# Rule-router weekly review — ${today}`, '',
    status, '',
    '## False fires to review',
    boxes.length ? boxes.join('\n') : 'None this week.', '',
    boxes.length ? 'Tick a box when you agree the rule fired on the wrong command, then ask Claude to tighten that rule\'s trigger. Leave it unticked if the rule was right.' : '',
    '## Where the detail is',
    `- Full weekly audit: \`${reportPath}\``,
    '- Every false fire so far: `node scripts/rules/rule-router-false-fires.mjs list` (in continuous-claude)',
  ].join('\n');
  const ntn = NTN_EXE;
  const run = spawnSync(ntn, ['pages', 'create', '--parent', `page:${parent}`, '--content', md, '--json'], {
    input: '', encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  let url = '';
  try { url = JSON.parse(run.stdout).url || ''; } catch { /* reported below */ }
  if (run.status !== 0 || !url) {
    console.log(`notion: page create failed (exit ${run.status}) ${String(run.stderr || run.stdout || '').slice(0, 300)}`);
    return 1;
  }
  console.log(`notion: ${url}`);
  return 0;
}

if (cmd === 'add') {
  const rule = opt('--rule'); const what = opt('--what');
  if (!rule || !what) { console.log('usage: add --rule <id> --what "<trigger words>" [--note "<why>"]'); process.exit(2); }
  capture({ rule, what, tool: opt('--tool', null), count: 1, reason: opt('--note', ''), source: opt('--source', 'manual') });
  console.log(`captured: ${rule} <- ${what}`);
} else if (cmd === 'list') {
  list(rest.includes('--json'));
} else if (cmd === 'review') {
  const report = opt('--report', join(repo, 'docs', 'self-improvement', 'audits', `rule-router-${today}.md`));
  const days = Number(opt('--days', '7'));
  const result = review(days, report);
  const parent = opt('--notion-parent');
  const notionCode = parent ? publishNotion(parent, days, result, report) : 0;
  process.exit(result.code || notionCode);
} else {
  console.log('usage: rule-router-false-fires.mjs add | list | review   (see the header for options)');
  process.exit(2);
}
