#!/usr/bin/env node
/**
 * upgrades-status -- one generated page of the planned CCv3 upgrades and their state (card ccv3-upgrades-status-page).
 *
 * Sources, all read when the page is built, none typed:
 *   1. review engine program: `node scripts/review-engine/program.mjs status --json` (run from the primary checkout; it refuses a linked worktree)
 *   2. lane board: `lane.mjs board --json` (open lanes only; re- lanes are the program's, so they are not counted again here)
 *   3. roadmap planned items: the COMMITTED ROADMAP.md of main (`git show main:ROADMAP.md`), never the working copy
 *   4. redesign brief: the phase list of .claudedocs/agentic-os-redesign/10-rethink-brief.md (a local file; it holds no state)
 * A source that is missing, unreadable or empty is "not checked". It never reads as zero, and the page counts how many.
 * A listed id is masked in every text, then counted: one left stops the page (exit 3). A count of 100 or more shows as "100+".
 *
 * Usage: node scripts/reports/upgrades-status.mjs --out <folder>   writes page.md, upgrades.html and manifest.json there. It sends nothing.
 * Exit: 0 written, 1 error, 2 usage, 3 a listed id is left or the id list is not usable.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countListed, maskListed, readIdList } from '../coordination/board-mask.mjs';

export const REFRESH_COMMAND = 'node scripts/reports/upgrades-status.mjs --out <folder>';
const SOURCES = ['review engine program', 'lane board', 'roadmap planned items', 'redesign brief'];

/** The count as shown: 100 or more is "100+" (a long count is not needed on this page). */
const shown = (n) => (n >= 100 ? '100+' : String(n));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A title for a reader: no code ticks, a run of 3 or more digits (a count) becomes "…" (a date stays), at most 90 characters, cut at a word. */
const cleanTitle = (s) => {
  const t = s.replace(/`/g, '').replace(/\s+/g, ' ').trim().replace(/\b(\d{4}-\d{2}-\d{2})\b|\d{3,}(?:,\d{3})*/g, (m, d) => d ?? '…');
  return t.length > 90 ? `${t.slice(0, 89).replace(/\s+\S*$/, '')}…` : t;
};

/** "2026-11-25 15:10 CST", from the clock argument only. */
export function stampOf(now) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
      .formatToParts(now).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** Open `- [ ]` items of the Planned section: { title, priority }. An absent section or no open item is null. */
export function parseRoadmapPlanned(text) {
  if (typeof text !== 'string') return null;
  const items = [];
  let inPlanned = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^## /.test(line)) { inPlanned = /^## Planned\b/.test(line); continue; }
    const m = inPlanned && /^- \[ \] (.*)$/.exec(line);
    if (!m) continue;
    const body = m[1];
    const pri = /\((high|medium|low) priority\)/.exec(body);
    const bold = /^\*\*(.+?)\*\*/.exec(body);
    let title = bold ? bold[1] : body.slice(0, pri ? pri.index : body.length).split('. ')[0];
    title = cleanTitle(title.replace(/[\s.:;,]+$/, ''));
    if (title) items.push({ title, priority: pri ? pri[1] : 'none' });
  }
  return items.length ? items : null;
}

/** The phase lines of "## 6. Build phases" of the brief: { title }. None is null. */
export function parseBriefPhases(text) {
  if (typeof text !== 'string') return null;
  const out = [];
  let inPhases = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^## /.test(line)) { inPhases = /Build phases/i.test(line); continue; }
    const m = inPhases && /^- \*\*(Phase \d+)\.\s*([^*]+?)\.?\*\*/.exec(line);
    if (m) out.push({ title: cleanTitle(`${m[1]}: ${m[2]}`) });
  }
  return out.length ? out : null;
}

function programModel(p) {
  if (!p || p.ok === false || !p.counts || !Array.isArray(p.waves) || p.waves.length === 0) return null;
  const waves = p.waves.map((w) => ({ wave: w.wave, lanes: w.lanes, done: w.done, inWork: w.inWork, blocked: w.blocked, planned: Math.max(0, w.lanes - w.done - w.inWork - w.blocked) }));
  const open = p.nextDecisionPoint && Array.isArray(p.nextDecisionPoint.open) ? p.nextDecisionPoint.open.length : null;
  return { lanes: p.counts.lanes, byState: p.counts.byState, go: p.go === true, waves, decisionOpen: open, decisionId: p.nextDecisionPoint?.id ?? null };
}

function trackModel(b) {
  const lanes = b && Array.isArray(b.lanes) ? b.lanes : [];
  if (lanes.length === 0) return null;
  const by = new Map();
  for (const l of lanes) {
    if (typeof l.id === 'string' && l.id.startsWith('re-')) continue;
    const t = by.get(l.track || 'none') ?? { track: l.track || 'none', planned: 0, inWork: 0, blocked: 0 };
    if (l.state === 'ready' || l.state === 'backlog') t.planned += 1;
    else if (l.state === 'active' || l.state === 'review') t.inWork += 1;
    else if (l.state === 'blocked') t.blocked += 1;
    by.set(l.track || 'none', t);
  }
  return [...by.values()].sort((a, b2) => a.track.localeCompare(b2.track));
}

function summaryMd(m, stamp) {
  const nc = m.notChecked;
  const L = [
    '# CCv3 Upgrades',
    `Built ${stamp} from main. Refresh: ${REFRESH_COMMAND}. Each refresh needs a word from Dave or the seat.`,
    nc.length ? `${nc.length} of ${SOURCES.length} sources not checked: ${nc.join(', ')}.` : `All ${SOURCES.length} sources checked.`,
    '',
    '## Review engine program',
  ];
  if (m.program) {
    const s = m.program.byState;
    L.push(`${m.program.lanes} lanes: done ${s.done}, in work ${(s.active ?? 0) + (s.review ?? 0)}, blocked ${s.blocked}, planned ${(s.backlog ?? 0) + (s.ready ?? 0)}.`);
    if (m.program.decisionOpen != null) L.push(`Open decision items for Dave: ${m.program.decisionOpen} (${m.program.decisionId}).`);
  } else L.push('not checked');
  L.push('', '## Other tracks (open lanes of the lane board)');
  if (m.tracks) for (const t of m.tracks) L.push(`- ${t.track}: planned ${shown(t.planned)}, in work ${shown(t.inWork)}, blocked ${shown(t.blocked)}`);
  else L.push('not checked');
  L.push('', `## Planned in the roadmap (committed copy${m.roadmapDate ? ` of ${m.roadmapDate}` : ''})`);
  if (m.roadmap) for (const i of m.roadmap) L.push(`- ${i.priority}: ${i.title}`);
  else L.push('not checked');
  L.push('', '## Plan phases (redesign brief; the brief holds no state)');
  if (m.phases) for (const i of m.phases) L.push(`- ${i.title}`);
  else L.push('not checked');
  return `${L.join('\n')}\n`;
}

function table(head, rows) {
  const th = head.map((h) => `<th>${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<${i ? 'td class="n"' : 'th scope="row"'}>${esc(c)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function pageHtml(m, stamp) {
  const sec = (h, body) => `<section><h2>${esc(h)}</h2>${body}</section>`;
  const nc = (what) => `<p class="nc">not checked: ${esc(what)}</p>`;
  const parts = [];
  parts.push(sec('Review engine program', m.program
    ? table(['Wave', 'Done', 'In work', 'Blocked', 'Planned'], m.program.waves.map((w) => [`Wave ${w.wave}`, w.done, w.inWork, w.blocked, w.planned]))
    : nc('review engine program')));
  parts.push(sec('Other tracks (open lanes, review engine lanes left out)', m.tracks
    ? table(['Track', 'Planned', 'In work', 'Blocked'], m.tracks.map((t) => [t.track, shown(t.planned), shown(t.inWork), shown(t.blocked)]))
    : nc('lane board')));
  parts.push(sec(`Planned in the roadmap (committed copy${m.roadmapDate ? ` of ${m.roadmapDate}` : ''})`, m.roadmap
    ? table(['Item', 'Priority'], m.roadmap.map((i) => [i.title, i.priority]))
    : nc('roadmap planned items')));
  parts.push(sec('Plan phases (redesign brief; it holds no state)', m.phases
    ? `<ol>${m.phases.map((i) => `<li>${esc(i.title)}</li>`).join('')}</ol>`
    : nc('redesign brief')));
  const css = 'body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:56rem;padding:1rem;background:#fff;color:#1a1a1a}'
    + '@media(prefers-color-scheme:dark){body{background:#16181c;color:#e8e8e8}th,td{border-color:#3a3d44}.nc{color:#f0b429}}'
    + 'table{border-collapse:collapse;width:100%;margin:.5rem 0}th,td{border-bottom:1px solid #ccc;padding:.35rem .5rem;text-align:left}td.n{text-align:right}.nc{color:#8a5a00;font-weight:600}h2{margin-top:1.5rem}';
  const head = `<h1>CCv3 Upgrades</h1><p>Built ${esc(stamp)} from main. Refresh: <code>${esc(REFRESH_COMMAND)}</code>. Each refresh needs a word from Dave or the seat.</p>`
    + `<p class="${m.notChecked.length ? 'nc' : ''}">${m.notChecked.length ? `${m.notChecked.length} of ${SOURCES.length} sources not checked: ${esc(m.notChecked.join(', '))}.` : `All ${SOURCES.length} sources checked.`}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CCv3 Upgrades</title><style>${css}</style></head><body>${head}${parts.join('')}</body></html>`;
}

/**
 * Builds the page from its sources (arguments only: no command runs here). `ids` is the listed-id list, `mask` and `count` are injectable.
 * Returns { pageMd, html, model, notChecked, masked }. Throws when the id list is unusable or a listed id is left after the mask.
 */
export function buildUpgradesPage({ now, program, board, roadmap, roadmapDate = null, brief, ids, mask = maskListed, count = countListed }) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('listed id list is not usable: no page');
  const model = { roadmapDate, program: programModel(program), tracks: trackModel(board), roadmap: parseRoadmapPlanned(roadmap), phases: parseBriefPhases(brief) };
  const notChecked = [];
  if (!model.program) notChecked.push(SOURCES[0]);
  if (!model.tracks) notChecked.push(SOURCES[1]);
  if (!model.roadmap) notChecked.push(SOURCES[2]);
  if (!model.phases) notChecked.push(SOURCES[3]);
  model.notChecked = notChecked;
  const stamp = stampOf(now);
  let masked = 0;
  const finish = (text) => {
    const m = mask(text, ids);
    masked += m.masked ?? 0;
    if (count(m.text, ids) > 0) throw new Error('a listed id is left after the mask: no page');
    return m.text;
  };
  return { pageMd: finish(summaryMd(model, stamp)), html: finish(pageHtml(model, stamp)), model, notChecked, masked };
}

// ---- command line -------------------------------------------------------------------------------------------------------------------------

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}
const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

/** The primary checkout: the parent of the git common dir (the program verb refuses a linked worktree). */
function primaryRoot(cwd) {
  const out = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return out ? dirname(out.trim()) : null;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--out');
  if (i < 0 || !argv[i + 1]) { console.error('usage: node scripts/reports/upgrades-status.mjs --out <folder>'); return 2; }
  const out = resolve(argv[i + 1]);
  const root = primaryRoot(process.cwd());
  if (!root) { console.error('upgrades-status: not in a git checkout'); return 1; }
  let ids;
  try { ids = readIdList(root); } catch { console.error('upgrades-status: the listed id list is not usable: no page'); return 3; }
  const lane = join(env.USERPROFILE || env.HOME || '', '.claude', 'scripts', 'lane.mjs');
  const brief = (() => { try { return readFileSync(join(root, '.claudedocs', 'agentic-os-redesign', '10-rethink-brief.md'), 'utf8'); } catch { return null; } })();
  let built;
  try {
    built = buildUpgradesPage({
      now: new Date(),
      program: parseJson(run(process.execPath, ['scripts/review-engine/program.mjs', 'status', '--json'], root)),
      board: parseJson(run(process.execPath, [lane, 'board', '--json'], root)),
      roadmap: run('git', ['show', 'main:ROADMAP.md'], root),
      roadmapDate: (run('git', ['log', '-1', '--format=%cs', 'main', '--', 'ROADMAP.md'], root) || '').trim() || null,
      brief,
      ids,
    });
  } catch (err) {
    console.error(`upgrades-status: ${err.message}`);
    return /listed id/.test(err.message) ? 3 : 1;
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'page.md'), built.pageMd);
  writeFileSync(join(out, 'upgrades.html'), built.html);
  const manifest = { builtAt: new Date().toISOString(), notChecked: built.notChecked, masked: built.masked, listedIdsLeft: 0, htmlBytes: Buffer.byteLength(built.html), mdBytes: Buffer.byteLength(built.pageMd) };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`upgrades-status: wrote page.md and upgrades.html, ${built.notChecked.length} of ${SOURCES.length} sources not checked, masked ${built.masked}, left 0`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main();
