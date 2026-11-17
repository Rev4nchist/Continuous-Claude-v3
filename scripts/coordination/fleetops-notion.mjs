#!/usr/bin/env node
/**
 * Renders the FleetOps Notion page (Notion-flavored Markdown) from the 7 lane-dash export files.
 * Card coord-fleetops-notion (Dave, 2026-11-17): FleetOps moved from a claude.ai Dashboard artifact to a Notion page.
 * The fleetops-refresh skill runs this, then replaces the page body.
 *
 * Usage: node scripts/coordination/fleetops-notion.mjs <folder of the 7 .json files> [--out <outdir>] [--ids-root <repo root>]
 *   --out: writes <outdir>/page.md and <outdir>/manifest.json. Without it the page goes to stdout. One count line goes to stderr.
 *   --ids-root: the root that holds the listed-id list (default: the repo root of this script).
 * Exit 1, nothing written: a file is missing or from another export, the id list is absent, bad or empty, or a listed id is left in the page.
 * No network. Text fields are masked and cut in fleetops-view.mjs; the whole page is masked and checked again here.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIdList, maskListed, countListed } from './board-mask.mjs';
import { buildView } from './fleetops-view.mjs';

export const FILE_IDS = Object.freeze(['lanes', 'tiles', 'assignments', 'projects', 'targets', 'meta', 'snapshots']);
const FORBIDDEN = Object.freeze(['<div', '<details', 'claude.ai/artifact/', '{h}', 'no_end', 'board_url']);

/** Reads the 7 files of `dir`. Throws when one is missing or when they come from more than one export. */
export function loadFiles(dir) {
  const read = (k) => {
    const text = readFileSync(join(dir, `${k}.json`), 'utf8');
    try { return JSON.parse(text); } catch { throw new Error(`${k}.json is not valid JSON`); }
  };
  const files = Object.fromEntries(FILE_IDS.map((k) => [k, read(k)]));
  const stampOf = files.meta.exportedAt;
  for (const [k, f] of Object.entries(files)) if (f.exportedAt !== stampOf) throw new Error(`${k}.json is from another export`);
  return files;
}

const escText = (s) => s.replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;')).replace(/([\\*_~`[\]$])/g, '\\$1');
/** A dotted file-like name (IMPACT.md, refs.mjs). Notion turns it into a web link on save (scratch read-back, 2026-11-17); a code span stops that. */
const DOTTED_NAME = /([A-Za-z0-9_-]+\.[A-Za-z]{2,5})(?![A-Za-z0-9])/g;
/** Escapes text for Notion markdown. A dotted name goes in a code span, unescaped (its characters cannot close or open one). */
const esc = (s) => String(s ?? '').split(DOTTED_NAME).map((part, i) => (i % 2 === 1 ? `\`${part}\`` : escText(part))).join('');
const gray = (s) => `<span color="gray">${esc(s)}</span>`;
const br = (...parts) => parts.filter(Boolean).join('<br />');
const callout = (icon, color, body) => `<callout icon="${icon}" color="${color}">\n${body}\n</callout>`;
const toggle = (heading, title, children) => `<toggle heading="${heading}">${title}\n\n${children}\n</toggle>`;
const tr = (cells, color) => [color ? `<tr color="${color}">` : '<tr>', ...cells.map((x) => `<td>${x}</td>`), '</tr>'].join('\n');
const table = (head, rows) => ['<table header-row="true">', tr(head.map(esc)), ...rows.map((r) => tr(r.cells, r.color)), '</table>'].join('\n');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const signed = (n) => (n > 0 ? `+${n}` : String(n));

const askCells = (r) => [br(esc(r.title), gray(r.id)), esc(`${r.band ?? 'no band'} · ${r.state}`), esc(`${r.asked} · ${r.age} d`)];
const askTable = (rows) => table(['Lane', 'Band · State', 'Asked'], rows.map((r) => ({ cells: askCells(r), color: r.old ? 'orange_bg' : undefined })));

function statRow(v) {
  const p = v.pile;
  const stats = [
    ['🙋', 'orange_bg', `<b>${v.asks.total}</b> wait on Dave<br />${v.asks.over} over 7 d`],
    ['📈', 'gray_bg', p ? `<b>${signed(p.change)}</b> open, ${p.span} days<br />${p.from} → ${p.to}` : '<b>–</b> open<br />too few snapshots'],
    ['💤', 'orange_bg', `<b>${v.never.total}</b>/${v.never.open} never started<br />${v.never.old} at 7 d or more`],
    ['⚙️', v.wip.lapsed ? 'red_bg' : 'green_bg', `<b>${v.wip.live}</b> live<br />${v.wip.lapsed} lapsed`],
    ['🔥', 'gray_bg', `<b>${v.p0.open}${v.p0.cap == null ? '' : ` of ${v.p0.cap}`}</b> P0${v.p0.cap == null ? '' : ' cap'}<br />${v.p0.unheld.length} no holder`],
  ];
  return `<columns>\n${stats.map(([i, c, b]) => `<column>\n${callout(i, c, b)}\n</column>`).join('\n')}\n</columns>`;
}

function waitingSection(v) {
  const a = v.asks;
  const parts = ['## 🙋 Waiting on Dave', `${plural(a.total, 'ask', 'asks')}: ${a.total - a.over} at 7 d or less, ${a.over} older. ${plural(a.blockedNoAsk, 'blocked lane has', 'blocked lanes have')} no ask.`];
  if (a.main.length) parts.push(askTable(a.main));
  for (const f of a.folds) parts.push(toggle('h3', esc(`${f.name}: ${plural(f.rows.length, 'ask', 'asks')}, oldest ${f.oldest} d`), askTable(f.rows)));
  if (a.other.length) parts.push(toggle('h3', esc(`Other projects: ${plural(a.other.length, 'ask', 'asks')}`), askTable(a.other)));
  return parts.join('\n\n');
}

function pileSection(v) {
  const p = v.pile;
  if (!p) return '## 📈 The pile\n\nToo few daily snapshots to show a change.';
  const note = p.partialDay ? ` ${esc(p.last)} is part of a day.` : '';
  const rows = p.days.map((d) => ({ cells: [esc(d.label), String(d.open), d.change == null ? '–' : esc(signed(d.change))] }));
  return ['## 📈 The pile', `Open per day, ${esc(p.first)} to ${esc(p.last)}: ${p.spark}  min ${p.min}, max ${p.max}.${note}`, table(['Day', 'Open', 'Change'], rows)].join('\n\n');
}

function neverSection(v) {
  const n = v.never;
  const rows = n.buckets.map((b) => ({ color: b.old ? 'orange_bg' : undefined, cells: [br(esc(b.label), b.old ? gray('needs a decision') : ''), '▇'.repeat(b.width) || '–', String(b.count)] }));
  const most = n.top.map((t) => `${esc(t.name)} ${t.count}`).join(' · ');
  return ['## 💤 Never started', `${n.total} of ${n.open} open lanes have no work yet.`, table(['Age', 'Bar', 'Lanes'], rows), most ? `Most: ${most}.` : ''].filter(Boolean).join('\n\n');
}

function wipSection(v) {
  const { wip, p0 } = v;
  const held = p0.unheld.map((u) => `${esc(u.title)} (${esc(u.id)})${u.age == null ? '' : `, asked ${u.age} d ago`}`).join('; ');
  const p0Line = `🔥 P0: ${p0.open}${p0.cap == null ? '' : ` of ${p0.cap}`} open.${held ? ` Not held: ${held}.` : ''}`;
  const rows = wip.rows.map((r) => ({
    color: r.lapsed ? 'red_bg' : undefined,
    cells: [br(esc(r.title), gray(r.id), r.goal ? esc(r.goal) : ''), esc(r.state), br(r.lapsed ? esc(`Lapsed ${r.lapsedOn} · ${r.lapsedDays} d`) : 'Live', r.holder ? gray(r.holder) : '')],
  }));
  return ['## ⚙️ Work in progress', p0Line, rows.length ? table(['Lane', 'State', 'Lease'], rows) : 'No lane is held.'].join('\n\n');
}

function projectsSection(v) {
  const rows = v.projects.map((p) => ({ color: p.decision ? 'yellow_bg' : undefined, cells: [esc(p.name), esc(p.state), esc(p.ended)] }));
  return ['## 🧭 Projects', rows.length ? table(['Project', 'State', 'End lanes done'], rows) : 'No project to show.'].join('\n\n');
}

function aboutText() {
  return [
    'This page shows the state of the lane board: what waits on Dave, how the pile changes, work in progress and each project.',
    'A Claude Code session rewrites it from the lane export when Dave says "refresh FleetOps". Do not edit it by hand.',
    'Every lane title, goal, holder and id is masked against the listed-id list before it leaves this machine.',
  ].join('\n\n');
}

/** The page body as Notion markdown, before the whole-page mask. `now` decides the stale colour. Throws on a forbidden string. */
export function renderPage(view, now = new Date()) {
  const stale = view.staleAtMs != null && now.getTime() > view.staleAtMs;
  const age = stale ? `Stale since ${esc(view.staleAt)}.` : `Stale after ${esc(view.staleAt)}.`;
  const p = view.pile;
  const takeaway = `**${plural(view.asks.total, 'lane waits', 'lanes wait')} on Dave.${p ? ` The pile ${p.change < 0 ? 'shrank' : 'grew'} by ${Math.abs(p.change)} in ${p.span} days.` : ''}**`;
  const out = [
    callout('🕒', stale ? 'red_bg' : 'gray_bg', br(`Data from ${esc(view.dataFrom)}. ${age}`, `Export \`${view.exportedAt}\`.`, 'To update, say "refresh FleetOps" in any Claude Code session.')),
    takeaway, statRow(view), waitingSection(view), pileSection(view), neverSection(view), wipSection(view), projectsSection(view),
    toggle('h2', '📅 Daily numbers', table(['Day', 'Open', 'Done', 'Blocked', 'Active', 'P0', 'P1', 'P2', 'No band', 'Never started'], view.daily.map((r) => ({ cells: r.map((x) => esc(x)) })))),
    toggle('h2', 'ℹ️ About this page', aboutText()),
  ].join('\n\n') + '\n';
  const bad = FORBIDDEN.find((f) => out.includes(f));
  if (bad) throw new Error(`the page holds a forbidden string (${bad})`);
  return out;
}

/** Masks the whole page again. Throws when a listed id is still in it. `mask` and `count` are injectable for a test. */
export function maskPage(raw, ids, { mask = maskListed, count = countListed } = {}) {
  const { text, masked } = mask(raw, ids);
  if (count(text, ids) > 0) throw new Error('a listed id is still in the page');
  return { page: text, masked };
}

const h2Of = (page) => (page.match(/^## |^<toggle heading="h2">/gm) ?? []).length;

/** The manifest of a written page: the numbers the refresh skill checks on the read-back. */
export function manifestOf(page, exportedAt, masked) {
  return { exportedAt, masked, bytes: Buffer.byteLength(page), h2Count: h2Of(page), sha256: createHash('sha256').update(page).digest('hex') };
}

function parseArgs(argv) {
  const o = { dir: null, out: null, idsRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--ids-root') o.idsRoot = resolve(argv[++i]);
    else if (!o.dir) o.dir = argv[i];
  }
  if (!o.dir) throw new Error('usage: node fleetops-notion.mjs <folder> [--out <outdir>] [--ids-root <root>]');
  return o;
}

function main(argv) {
  try {
    const o = parseArgs(argv);
    const files = loadFiles(o.dir);
    const ids = readIdList(o.idsRoot);
    const view = buildView(files, ids);
    const { page, masked } = maskPage(renderPage(view), ids);
    const manifest = manifestOf(page, view.exportedAt, view.masked + masked);
    if (o.out) {
      mkdirSync(o.out, { recursive: true });
      writeFileSync(join(o.out, 'page.md'), page);
      writeFileSync(join(o.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    } else process.stdout.write(page);
    console.error(`fleetops-notion: masked ${manifest.masked} listed id(s), ${manifest.h2Count} h2, ${manifest.bytes} bytes, listed ids left 0`);
    return 0;
  } catch (err) {
    console.error(`fleetops-notion: ${err.message}; nothing written`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
