#!/usr/bin/env node
/**
 * rule-router-false-fires.mjs -- the capture log of rules that fired on the wrong command.
 *
 * Capture log: ~/.claude/logs/rule-router-false-fires.jsonl (append-only, one row per capture):
 *   { ts, rule, what, tool, count, fires, from, to, reason, source: "review" | "agent" | "manual", week, window }
 *   `from` and `to` date the fires the row stands for, `fires` how many. Old rows have none (see `rate`).
 *
 * Commands:
 *   add --rule <id> --what "<trigger words>" [--note "<why it is wrong>"] [--fired-at <ISO time>]   record one by hand
 *   list [--json]                                                          every false fire so far
 *   rate --since <ISO time> [--until <ISO time>] [--json]                  false fires over rule fires, one window
 *   review [--days 7] [--report <file.md>]                                 judge this week's fires
 *
 * `review` reads the fire log, takes each distinct (rule, trigger words) pair, and asks a headless
 * `claude -p` session (Sonnet, no tools) whether the rule is about that command. Pairs judged
 * "false_fire" are appended to the capture log, and a verdict table is appended to the week's audit
 * report. Exit 1 when the judge call fails, so the scheduled task shows it.
 * Options for tests: --log <fires.jsonl> --capture <false-fires.jsonl> --manifest <manifest.json> --judge-reply <verdicts.json>
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
    if (!isFire(f)) continue; // a re-arm row (or any kind that is no fire) is not judged, whatever its rules array holds
    if (!f.what || /^\$\w+=/.test(f.what)) continue; // old log format: nothing to judge
    for (const rule of f.rules || []) {
      const k = `${rule}|${f.what}`;
      const at = new Date(f.ts).toISOString();
      const e = pairs.get(k) || { rule, what: f.what, tool: f.tool, count: 0, from: at, to: at };
      e.count++; if (at < e.from) e.from = at; if (at > e.to) e.to = at;
      pairs.set(k, e);
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
  // --judge-reply <file>: a test option. The file holds the verdict array; no judge call runs.
  const replyFile = opt('--judge-reply');
  if (replyFile && !rest.includes('--capture')) { console.log('--judge-reply needs --capture <file>: a test run never writes the live capture log'); process.exit(2); }
  const run = replyFile
    ? (() => { try { return { status: 0, stdout: JSON.stringify({ result: readFileSync(replyFile, 'utf8') }), stderr: '' }; } catch { return { status: 1, stdout: '', stderr: 'reply file not readable' }; } })()
    : spawnSync('claude', ['-p', '--model', 'sonnet', '--output-format', 'json', '--tools', '', '--strict-mcp-config'], {
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
        capture({ rule: p.rule, what: p.what, tool: p.tool, count: p.count, fires: p.count, from: p.from, to: p.to, reason: v.reason, source: 'review', window });
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

/**
 * The false-fire rate of one window, with ONE reading: false fires over rule fires, both inside the window.
 * Denominator: one fire per rule named in a `deny` or `inject` row. A re-arm row is no fire. A row with no
 * `kind` (old format) is a fire. Numerator: the `fires` (else `count`, else 1) of every capture row whose
 * fires lie wholly in the window. The fires of a row are dated by `from` and `to`; an old row has neither
 * and is dated by its capture time (`datedByCapture`). A row that only partly lies in the window is
 * reported (`partialRows`) and not counted: its fires cannot be split.
 */
const REVIEW_DAYS = 7; // `review --days 7` is what the scheduled task runs (scheduled-rule-router-review.ps1:57)

/** A fire row: kind deny or inject, or no kind (old format). A re-arm row, and any other kind, is no fire. */
function isFire(f) { return f.kind === undefined || f.kind === 'deny' || f.kind === 'inject'; }

/** How many fires a capture row stands for: `fires`, else `count`, else 1. A value that is no number >= 0 counts 1. */
function firesOf(c) {
  const n = Number(c.fires ?? c.count ?? 1);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

export function rate(sinceMs, untilMs) {
  const inWin = (ms) => ms >= sinceMs && ms <= untilMs;
  let fireRows = 0; let rearmRows = 0; let ruleFires = 0; let badRows = 0;
  for (const f of readJsonl(firesPath)) {
    const at = Date.parse(f.ts);
    if (Number.isNaN(at)) { badRows++; continue; }
    if (!inWin(at)) continue;
    if (f.kind === 'rearm') { rearmRows++; continue; }
    if (!isFire(f)) continue;
    fireRows++; ruleFires += (f.rules || []).length;
  }
  // Date each capture row. An old review row has no fire dates: the scheduled review judges `--days 7`, so its fires
  // lie in the 7 days before its capture. Any other old row is dated by its capture time.
  const rows = [];
  for (const c of readJsonl(capturePath)) {
    const to = Date.parse(c.to || c.from || c.ts);
    const from = c.from ? Date.parse(c.from) : (c.source === 'review' ? Date.parse(c.ts) - REVIEW_DAYS * 86400000 : Date.parse(c.ts));
    if (Number.isNaN(from) || Number.isNaN(to)) { badRows++; continue; }
    rows.push({ c, from, to, old: !c.from, whole: inWin(from) && inWin(to), key: `${c.rule}|${c.what}` });
  }
  // One fire, one count: a row of a session or of a hand that lies inside a counted review row of the same pair is the same fire.
  const reviews = rows.filter((r) => r.whole && r.c.source === 'review');
  let falsePairs = 0; let falseFires = 0; let datedByCapture = 0; let partialRows = 0; let dedupedRows = 0;
  for (const r of rows) {
    if (r.whole) {
      if (r.c.source !== 'review' && reviews.some((v) => v.key === r.key && r.from >= v.from && r.to <= v.to)) { dedupedRows++; continue; }
      falsePairs++; falseFires += firesOf(r.c);
      if (r.old) datedByCapture++;
    } else if (inWin(r.from) || inWin(r.to) || (r.from < sinceMs && r.to > untilMs)) partialRows++;
  }
  const ratePercent = ruleFires ? Math.round((falseFires / ruleFires) * 10000) / 100 : null;
  return { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), fireRows, rearmRows, ruleFires, falsePairs, falseFires, datedByCapture, partialRows, dedupedRows, badRows, ratePercent };
}

function printRate(r, since) {
  console.log(`False-fire rate since ${since}: ${r.falseFires} false fires of ${r.ruleFires} rule fires = ${r.ratePercent ?? 'n/a'} percent`);
  console.log(`  pairs (capture rows in the window): ${r.falsePairs}; fire rows: ${r.fireRows}; re-arm rows (not fires): ${r.rearmRows}`);
  console.log(`  dated by capture (old rows with no fire dates): ${r.datedByCapture}; partly in the window (not counted): ${r.partialRows}`);
  console.log(`  same fire recorded twice (not counted again): ${r.dedupedRows}; rows with a bad timestamp (left out): ${r.badRows}`);
  console.log('  Lower bound until the weekly review has judged the window.');
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
  if (opt('--fired-at') && Number.isNaN(Date.parse(opt('--fired-at')))) { console.log('invalid --fired-at: give an ISO time, e.g. 2026-11-17T10:00:00Z'); process.exit(2); }
  const firedAt = opt('--fired-at') ? new Date(opt('--fired-at')).toISOString() : new Date().toISOString();
  capture({ rule, what, tool: opt('--tool', null), count: 1, fires: 1, from: firedAt, to: firedAt, reason: opt('--note', ''), source: opt('--source', 'manual') });
  console.log(`captured: ${rule} <- ${what}`);
} else if (cmd === 'rate') {
  const since = opt('--since');
  if (!since || Number.isNaN(Date.parse(since))) { console.log('usage: rate --since <ISO time> [--until <ISO time>] [--json]'); process.exit(2); }
  const untilMs = opt('--until') ? Date.parse(opt('--until')) : Date.now();
  if (Number.isNaN(untilMs) || untilMs < Date.parse(since)) { console.log('invalid --until: give an ISO time that is not before --since'); process.exit(2); }
  const r = rate(Date.parse(since), untilMs);
  if (rest.includes('--json')) console.log(JSON.stringify(r));
  else printRate(r, since);
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
  console.log('usage: rule-router-false-fires.mjs add | list | rate | review   (see the header for options)');
  process.exit(2);
}
