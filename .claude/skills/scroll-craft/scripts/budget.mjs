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
 *   CLS              0.1       (web.dev "good" threshold)
 *
 * --mobile also throttles like Lighthouse's mobile preset (150 ms RTT,
 * 1.6 Mbit/s down, 4x CPU), because localhost LCP is otherwise meaningless.
 * Exits 1 when any budget fails. Resolves playwright-core from the build
 * project (cwd), like shoot.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

let chromium;
try {
  ({ chromium } = createRequire(path.join(process.cwd(), "package.json"))("playwright-core"));
} catch {
  console.error("playwright-core not found. Run this in the build project after:\n  npm i playwright-core");
  process.exit(1);
}

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const MOBILE = argv.includes("--mobile");
const URL = arg("--url", "http://localhost:4500");
const MAX_KB = Number(arg("--max-kb", MOBILE ? 2000 : 4000));
const MAX_LCP = Number(arg("--max-lcp", 2500));
const MAX_CLS = Number(arg("--max-cls", 0.1));

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

  // Observe from the first paint, buffered, so nothing is missed before load.
  await page.addInitScript(() => {
    window.__budget = { lcp: 0, cls: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__budget.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__budget.cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });

  if (MOBILE) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }

  const res = await page.goto(URL, { waitUntil: "load", timeout: 120000 });
  await page.waitForTimeout(2000);   // settle; no scroll, so lazy clips stay unfetched

  const m = await page.evaluate(() => {
    const size = (e) => Math.max(e.transferSize || 0, e.encodedBodySize || 0);
    const nav = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource");
    return {
      bytes: (nav ? size(nav) : 0) + res.reduce((s, r) => s + size(r), 0),
      count: res.length + 1,
      heaviest: res.map((r) => ({ url: r.name, kb: Math.round(size(r) / 1024) }))
        .sort((a, b) => b.kb - a.kb).slice(0, 5),
      lcp: Math.round(window.__budget.lcp),
      cls: +window.__budget.cls.toFixed(3),
    };
  });

  const kb = Math.round(m.bytes / 1024);
  const checks = [
    ["initial payload", `${kb} KB`, `<= ${MAX_KB} KB`, kb <= MAX_KB],
    ["LCP", `${m.lcp} ms`, `<= ${MAX_LCP} ms`, m.lcp > 0 && m.lcp <= MAX_LCP],
    ["CLS", `${m.cls}`, `<= ${MAX_CLS}`, m.cls <= MAX_CLS],
  ];
  console.log(`budget ${MOBILE ? "mobile (throttled)" : "desktop"}  ${URL}  HTTP ${res?.status() ?? "?"}  ${m.count} requests`);
  for (const [name, got, want, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(16)} ${got.padStart(10)}   ${want}`);
  console.log("  heaviest at load:");
  for (const h of m.heaviest) console.log(`    ${String(h.kb).padStart(6)} KB  ${h.url}`);
  process.exitCode = checks.every((c) => c[3]) ? 0 : 1;
} finally {
  await browser.close();
}
