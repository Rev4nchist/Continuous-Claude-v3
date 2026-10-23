#!/usr/bin/env node
// publish.mjs — Publish the Self-Improvement Triage Cockpit to the ai-enablement-decks
// GitHub Pages site, UNLISTED (no decks.json card — URL-knowledge-only, PIK precedent).
//
// Immutability contract (premortem finding #2, 2026-07-24): each publish lands
// under a DATED folder that is never rewritten by later days' runs, plus a `latest/`
// alias that is explicitly non-audit. Registry `artifactUrl` values must NEVER point
// here (finding #1) — they stay on the per-run Notion child page (run-research.ps1).
//
//   self-improvement/<YYYY-MM-DD>/index.html   (immutable per day)
//   self-improvement/latest/index.html         (mutable alias, non-audit)
//
// Flow: build cockpit (unless --skip-build) -> copy out/triage.html to both paths
//       -> git add + commit + push (Pages auto-deploys).
//
// Usage: node scripts/self-improvement/triage/publish.mjs [--dry-run] [--no-push]
//        [--skip-build] [--date=YYYY-MM-DD] [--repo=<decks repo path>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.join(os.homedir(), 'Projects', 'ai-enablement-decks');
const SITE_DIR = 'self-improvement';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const PUSH = !args.includes('--no-push');
const SKIP_BUILD = args.includes('--skip-build');
const repoArg = args.find((a) => a.startsWith('--repo='));
const dateArg = args.find((a) => a.startsWith('--date='));
const REPO = (repoArg ? repoArg.split('=')[1] : DEFAULT_REPO).replace(/\\/g, '/');

const log = (m) => console.log(`[triage-publish] ${m}`);
const die = (m) => { console.error(`[triage-publish] FAILED: ${m}`); process.exit(1); };

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const DATE = dateArg ? dateArg.split('=')[1] : todayStamp();
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) die(`bad --date '${DATE}' (want YYYY-MM-DD)`);

function git(...a) {
  return execFileSync('git', a, { cwd: REPO, encoding: 'utf8', windowsHide: true }).trim();
}

// --- Pre-flight ----------------------------------------------------------
if (!fs.existsSync(REPO)) die(`decks repo not found at ${REPO} (pass --repo=<path>)`);
if (!fs.existsSync(path.join(REPO, 'decks.json'))) die(`${REPO} does not look like the decks repo (no decks.json)`);

// 1) Build the cockpit (fresh render of all proposals).
const outHtml = path.join(HERE, 'out', 'triage.html');
if (!SKIP_BUILD) {
  execFileSync(process.execPath, [path.join(HERE, 'build.mjs')], { stdio: 'inherit', windowsHide: true });
}
if (!fs.existsSync(outHtml)) die(`no ${outHtml} — build failed or --skip-build with no prior build`);
const html = fs.readFileSync(outHtml);
if (html.length < 10_000) die(`out/triage.html suspiciously small (${html.length} bytes) — refusing to publish`);

// 2) Copy to dated (immutable per day) + latest (alias).
const datedDir = path.join(REPO, SITE_DIR, DATE);
const latestDir = path.join(REPO, SITE_DIR, 'latest');
log(`publishing ${(html.length / 1024).toFixed(1)} KiB -> ${SITE_DIR}/${DATE}/ + ${SITE_DIR}/latest/ (unlisted, no card)`);
if (!DRY) {
  for (const dir of [datedDir, latestDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
  }
}

// 3) Commit + push (Pages auto-deploys). Scoped add — never `git add -A`.
if (DRY) { log('dry-run: no git operations'); process.exit(0); }
git('add', '--', `${SITE_DIR}/${DATE}/index.html`, `${SITE_DIR}/latest/index.html`);
const staged = git('diff', '--cached', '--name-only');
if (!staged) { log('nothing changed — cockpit content identical to last publish; skipping commit'); process.exit(0); }
git('commit', '-m', `self-improvement: publish triage cockpit ${DATE} (unlisted)`);
if (PUSH) {
  git('push');
  log('pushed — Pages will auto-deploy');
} else {
  log('committed locally (--no-push)');
}
log(`URL (once deployed): https://rev4nchist.github.io/ai-enablement-decks/${SITE_DIR}/${DATE}/ (+ /latest/)`);
