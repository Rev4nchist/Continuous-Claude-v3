#!/usr/bin/env node
/**
 * e2e -- the browser check of the FleetOps HTML embed (card coord-fleetops-notion).
 *
 * Usage: node scripts/coordination/fleetops/e2e.mjs <outdir>
 *   <outdir> holds fleetops.html and manifest.json of a real render (fleetops-html.mjs --out <outdir>). The script also renders the fixture
 *   into <outdir>/fixture (a fake id root), then opens each page at 1280, 760, 430 and 390 px, light and dark, with the clock at export + 30 min.
 *   Each page opens twice: inside an iframe sandbox="allow-scripts" (like the Notion embed; 500 px tall at 760 and up, 900 px below) and direct.
 * Saves the screenshots and results.json (counts only, no page text) in <outdir>. Exit 1 when a check fails.
 * Checks: no console error, no failed request, no horizontal overflow, the 5 tiles inside the first 500 px at 760 and 1280, 4 ask rows whose bottom
 * edge is at or above 500 px at 760, no two chart texts that overlap, and the 3 clock states (snapshot, behind, stale).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const COORD = resolve(HERE, '..');
const require = createRequire(import.meta.url);
const FRAME_H = 500;

function loadPlaywright() {
  const candidates = ['playwright'];
  for (let d = HERE; dirname(d) !== d; d = dirname(d)) candidates.push(join(d, 'node_modules', 'playwright'));
  for (const c of candidates) { try { return require(c); } catch { /* next */ } }
  throw new Error('playwright is not installed in this checkout or one above it');
}

/** The measurements of one page, run inside the page (or its iframe). Counts and numbers only. */
function measure(frameH) {
  const rect = (e) => e.getBoundingClientRect();
  const tiles = [...document.querySelectorAll('.tile')];
  const rows = [...document.querySelectorAll('#asks .row')].filter((r) => r.offsetParent !== null);
  const texts = [...document.querySelectorAll('#pileChart svg text')].map(rect).filter((r) => r.width > 0);
  let collisions = 0;
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]; const b = texts[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) collisions += 1;
    }
  }
  const wait = tiles[0] ? tiles[0].textContent : '';
  return {
    innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth + 0.5,
    tiles: tiles.length, tilesWithin: tiles.filter((t) => rect(t).bottom <= frameH).length,
    askRows: rows.length, askRowsWithin: rows.filter((r) => rect(r).bottom <= frameH).length,
    chartTexts: texts.length, collisions,
    chip: document.getElementById('stateWord')?.textContent ?? '', chipClass: document.getElementById('state')?.className ?? '',
    waitTileHasDecisions: /project decision/.test(wait), leaseTexts: [...document.querySelectorAll('.wrow .when b')].map((b) => b.textContent),
    pileSubtitle: document.getElementById('pileCount')?.textContent ?? '', sparkVisible: !!document.querySelector('.spark') && rect(document.querySelector('.spark')).width > 0,
  };
}

function renderFixture(dir) {
  const root = join(tmpdir(), `fleetops-e2e-root-${process.pid}`);
  mkdirSync(join(root, '.claudedocs'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'eval', 'review-eval'), { recursive: true });
  writeFileSync(join(root, '.claudedocs', '2026-11-01-pr-review-dataset.json'), JSON.stringify({ prs: [{ pr: 4242 }], findings: [{ pr: 4242, round: 'abc1234def' }] }));
  writeFileSync(join(root, 'scripts', 'eval', 'review-eval', 'config.json'), '{}');
  try {
    const r = spawnSync(process.execPath, [join(COORD, 'fleetops-html.mjs'), join(COORD, 'fixtures', 'fleetops-mini'), '--out', dir, '--ids-root', root], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fixture render failed: ${r.stderr}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function wrapperFor(dir, width, height) {
  const file = join(dir, `.wrapper-${width}.html`);
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:gray"><iframe sandbox="allow-scripts" src="fleetops.html" width="${width}" height="${height}" style="border:0;display:block"></iframe>`);
  return file;
}

async function openCase(browser, c, width, scheme, now) {
  const height = width >= 700 ? FRAME_H : 900;
  const ctx = await browser.newContext({ viewport: { width: width + 4, height: height + 4 }, colorScheme: scheme, deviceScaleFactor: width < 500 ? 2 : 1 });
  await ctx.addInitScript((n) => { window.__FLEETOPS_NOW__ = n; }, now);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text().slice(0, 120)}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 120)}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url().slice(0, 60)}`));
  page.on('request', (r) => { if (!/^(file|data|about|blob):/.test(r.url())) problems.push(`network: ${r.url().slice(0, 60)}`); });
  return { ctx, page, problems, height };
}

async function checkCase(browser, c, width, scheme, results) {
  const now = c.exportedMs + 30 * 60000;
  const tag = `${c.name}-${width}-${scheme}`;
  const { ctx, page, problems, height } = await openCase(browser, c, width, scheme, now);
  await page.goto(pathToFileURL(wrapperFor(c.dir, width, height)).href);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame.waitForSelector('#strip .tile');
  const m = await frame.evaluate(measure, FRAME_H);
  await page.screenshot({ path: join(c.dir, `${tag}-frame.png`) });
  await ctx.close();

  const direct = await openCase(browser, c, width, scheme, now);
  await direct.page.goto(pathToFileURL(join(c.dir, 'fleetops.html')).href);
  await direct.page.waitForSelector('#strip .tile');
  await direct.page.screenshot({ path: join(c.dir, `${tag}-full.png`), fullPage: true });
  const dm = await direct.page.evaluate(measure, FRAME_H);
  const all = [...problems, ...direct.problems];
  await direct.ctx.close();

  const wide = width >= 760;
  const failed = [];
  if (all.length) failed.push('console or network problems');
  if (m.overflow || dm.overflow) failed.push('horizontal overflow');
  if (m.tiles !== 5) failed.push('not 5 tiles');
  if (wide && m.tilesWithin !== 5) failed.push('tiles below 500 px');
  // The fixture has a fold header and a subhead before its newer asks, so 3 plain rows is its floor; the real export must show 4.
  if (width === 760 && m.askRowsWithin < (c.name === 'real' ? 4 : 3)) failed.push(`fewer than ${c.name === 'real' ? 4 : 3} ask rows inside 500 px`);
  if (m.collisions || dm.collisions) failed.push('chart texts overlap');
  if (m.chip !== 'Snapshot, 30 min old' || !/live/.test(m.chipClass)) failed.push('clock chip');
  if (width <= 980 && m.sparkVisible) failed.push('sparkline shown in a compact tile');
  results.push({ case: c.name, width, scheme, problems: all, framed: m, directOverflow: dm.overflow, failed });
}

async function checkClockStates(browser, c, results) {
  const staleAt = JSON.parse(readFileSync(join(c.dir, 'fleetops.html'), 'utf8').match(/id="fleetops-data">([\s\S]*?)<\/script>/)[1]).staleAtMs;
  const states = [['behind', c.exportedMs + 3 * 3600000, /^Behind, 3 h old$/, 'behind'], ['stale', staleAt + 3600000, /^Stale since /, 'stale']];
  for (const [name, now, re, cls] of states) {
    const { ctx, page, problems } = await openCase(browser, c, 1280, 'light', now);
    await page.goto(pathToFileURL(join(c.dir, 'fleetops.html')).href);
    await page.waitForSelector('#strip .tile');
    const m = await page.evaluate(measure, FRAME_H);
    await page.screenshot({ path: join(c.dir, `${c.name}-state-${name}.png`), clip: { x: 0, y: 0, width: 1284, height: 120 } });
    await ctx.close();
    const failed = [];
    if (!re.test(m.chip) || !m.chipClass.includes(cls)) failed.push(`chip is not ${name}`);
    if (problems.length) failed.push('console problems');
    results.push({ case: c.name, state: name, chip: m.chip, leaseTexts: m.leaseTexts, failed });
  }
}

async function main() {
  const dir = process.argv[2] ? resolve(process.argv[2]) : null;
  if (!dir || !existsSync(join(dir, 'fleetops.html'))) { console.error('usage: node e2e.mjs <outdir with fleetops.html and manifest.json>'); return 1; }
  const fixtureDir = join(dir, 'fixture');
  renderFixture(fixtureDir);
  const cases = [dir, fixtureDir].map((d, i) => ({ name: i ? 'fixture' : 'real', dir: d, exportedMs: Date.parse(JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')).exportedAt) }));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const c of cases) {
      for (const width of [1280, 760, 430, 390]) for (const scheme of ['light', 'dark']) await checkCase(browser, c, width, scheme, results);
      await checkClockStates(browser, c, results);
    }
  } finally { await browser.close(); }
  for (const c of cases) for (const f of [1280, 760, 430, 390]) rmSync(join(c.dir, `.wrapper-${f}.html`), { force: true });
  const failed = results.filter((r) => r.failed.length);
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify({ runs: results.length, failedRuns: failed.length, failures: failed.map((r) => ({ case: r.case, width: r.width, scheme: r.scheme, state: r.state, failed: r.failed })), results }, null, 2)}\n`);
  console.log(`e2e: ${results.length} runs, ${failed.length} failed${failed.length ? ': ' + failed.map((r) => `${r.case} ${r.width ?? r.state} ${r.scheme ?? ''} ${r.failed.join(', ')}`).join(' | ') : ''}`);
  return failed.length ? 1 : 0;
}

main().then((c) => { process.exitCode = c; }, (e) => { console.error(`e2e: ${e.message}`); process.exitCode = 1; });
