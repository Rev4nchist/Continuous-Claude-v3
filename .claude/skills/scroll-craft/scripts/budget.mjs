#!/usr/bin/env node
/**
 * scrollcraft performance budget check (CCv3 addition).
 *
 * Loads the page once in a fresh headless Chrome, does NOT scroll, and
 * measures what the visitor pays before they touch anything: bytes fetched,
 * Largest Contentful Paint and Cumulative Layout Shift. Layered alpha planes
 * and scrub video are heavy; this is the gate that keeps the opening fast.
 *
 *   node budget.mjs --url http://localhost:4500              # desktop
 *   node budget.mjs --url http://localhost:4500 --mobile     # 390x844, throttled
 *
 * Budgets (override with --max-kb, --max-lcp, --max-cls):
 *   initial payload  desktop 4000 KB, mobile 2000 KB
 *     The engine loads the hero act's clip at open (an act's clip once the act
 *     is within 3 viewport-heights, scrollcraft.js:859; a worldflight leg within
 *     1.6, :738), and assets.md puts a 5s clip at ~3 MB desktop / ~1.5 MB
 *     mobile. So: one hero clip plus ~1 MB (desktop) or ~0.5 MB (mobile) of
 *     posters, fonts and engine. The ~9 MB whole-page video guideline in
 *     assets.md still applies separately.
 *   LCP              2500 ms   (web.dev "good" threshold)
 *   CLS              0.1       (web.dev "good" threshold; largest session window)
 *
 * How it measures:
 * - Bytes come from the browser's own network log (CDP encodedDataLength), so a
 *   cross-origin asset without Timing-Allow-Origin cannot count as zero.
 * - CLS is the largest session window (shifts < 1 s apart, window <= 5 s), the
 *   web.dev definition, not the sum of every shift.
 * - After load it keeps observing until the network is idle and LCP/CLS have
 *   not changed for 1.5 s, capped at --settle-ms (default 30000). A capped run
 *   says so.
 * --mobile also throttles like Lighthouse's mobile preset (150 ms RTT,
 * 1.6 Mbit/s down, 4x CPU), because localhost LCP is otherwise meaningless.
 * Exits 1 when any budget fails or the page answers with an HTTP error, 2 on a
 * usage error. Resolves playwright-core from the build project (cwd), like
 * shoot.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
function usage(msg) { console.error(`budget.mjs: ${msg}`); process.exit(2); }
// Absent flag -> default. Present flag without a value -> usage error, never a
// silent default.
function arg(name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`${name} needs a value`);
  return v;
}
function num(name, dflt, { min = 0 } = {}) {
  const v = arg(name, dflt);
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) usage(`${name} must be a number >= ${min}, got "${v}"`);
  return n;
}

const MOBILE = argv.includes("--mobile");
const URL = arg("--url", "http://localhost:4500");
const MAX_KB = num("--max-kb", MOBILE ? 2000 : 4000, { min: 1 });
const MAX_LCP = num("--max-lcp", 2500, { min: 1 });
const MAX_CLS = num("--max-cls", 0.1);
const SETTLE_CAP = num("--settle-ms", 30000, { min: 1000 });
const QUIET_MS = 1500;

let chromium;
try {
  ({ chromium } = createRequire(path.join(process.cwd(), "package.json"))("playwright-core"));
} catch {
  console.error("playwright-core not found. Run this in the build project after:\n  npm i playwright-core");
  process.exit(1);
}

const CHROME = [
  process.env.SCROLLCRAFT_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error("No installed Chrome found. Set SCROLLCRAFT_CHROME to its path."); process.exit(1); }

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext(MOBILE
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  // Browser-level byte and in-flight accounting.
  const cdp = await context.newCDPSession(page);
  const urls = new Map(), bytes = new Map(), inflight = new Set();
  let lastNet = Date.now();
  cdp.on("Network.requestWillBeSent", (e) => { urls.set(e.requestId, e.request.url); inflight.add(e.requestId); lastNet = Date.now(); });
  cdp.on("Network.loadingFinished", (e) => { bytes.set(e.requestId, e.encodedDataLength || 0); inflight.delete(e.requestId); lastNet = Date.now(); });
  cdp.on("Network.loadingFailed", (e) => { inflight.delete(e.requestId); lastNet = Date.now(); });
  await cdp.send("Network.enable");
  if (MOBILE) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }

  // Observe from the first paint, buffered. CLS = largest session window.
  await page.addInitScript(() => {
    const b = (window.__budget = { lcp: 0, cls: 0, shifts: [] });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) b.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    let cur = 0, first = 0, last = 0;
    const who = (n) => !n || !n.tagName ? "?" :
      n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") +
      (typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\s+/).join(".") : "");
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        if (cur && e.startTime - last < 1000 && e.startTime - first < 5000) { cur += e.value; last = e.startTime; }
        else { cur = e.value; first = last = e.startTime; }
        b.cls = Math.max(b.cls, cur);
        b.shifts.push({ value: e.value, at: Math.round(e.startTime), sources: (e.sources || []).map((s) => who(s.node)) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

  const res = await page.goto(URL, { waitUntil: "load", timeout: 120000 });
  const status = res ? res.status() : null;

  // Settle: network idle and LCP/CLS unchanged for QUIET_MS, capped. No scroll,
  // so clips further down stay unfetched.
  const t0 = Date.now();
  let prev = "", lastChange = Date.now(), capped = false;
  for (;;) {
    await page.waitForTimeout(250);
    const snap = await page.evaluate(() => `${window.__budget.lcp}|${window.__budget.cls}`);
    if (snap !== prev) { prev = snap; lastChange = Date.now(); }
    const quiet = Date.now() - Math.max(lastChange, lastNet);
    if (inflight.size === 0 && quiet >= QUIET_MS) break;
    if (Date.now() - t0 >= SETTLE_CAP) { capped = true; break; }
  }

  const m = await page.evaluate(() => ({
    lcp: Math.round(window.__budget.lcp),
    cls: +window.__budget.cls.toFixed(3),
    shifts: window.__budget.shifts.sort((a, b) => b.value - a.value).slice(0, 3),
  }));
  let total = 0;
  const files = [];
  for (const [id, n] of bytes) { total += n; files.push({ url: urls.get(id) || id, kb: Math.round(n / 1024) }); }
  const kb = Math.round(total / 1024);

  const checks = [
    ["HTTP status", `${status ?? "none"}`, "< 400", status !== null && status < 400],
    ["initial payload", `${kb} KB`, `<= ${MAX_KB} KB`, kb <= MAX_KB],
    ["LCP", `${m.lcp} ms`, `<= ${MAX_LCP} ms`, m.lcp > 0 && m.lcp <= MAX_LCP],
    ["CLS", `${m.cls}`, `<= ${MAX_CLS}`, m.cls <= MAX_CLS],
  ];
  console.log(`budget ${MOBILE ? "mobile (throttled)" : "desktop"}  ${URL}  ${bytes.size} requests  ` +
    (capped ? `observation CAPPED at ${SETTLE_CAP} ms (still loading)` : `settled after ${Date.now() - t0} ms`));
  for (const [name, got, want, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(16)} ${got.padStart(10)}   ${want}`);
  console.log("  heaviest at open:");
  for (const f of files.sort((a, b) => b.kb - a.kb).slice(0, 5)) console.log(`    ${String(f.kb).padStart(6)} KB  ${f.url}`);
  if (m.shifts.length) {
    console.log("  largest layout shifts:");
    for (const s of m.shifts) console.log(`    ${s.value.toFixed(3)} at ${s.at} ms  ${s.sources.join(", ") || "(no source)"}`);
  }
  process.exitCode = checks.every((c) => c[3]) ? 0 : 1;
} finally {
  await browser.close();
}
