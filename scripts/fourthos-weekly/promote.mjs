#!/usr/bin/env node
// promote.mjs — Promote the staged FourthOS weekly preview to a dated, listed card.
//
// Model: each week's report becomes its OWN dated deck under fourthos/<YYYY-MM-DD>/,
// surfaced as a card in the "sponsor-updates" section of decks.json (newest-first;
// the hub shows one row and collapses the rest). The newest card is `featured`.
//
// Flow:
//   fourthos/preview/  ->  fourthos/<date>/   (the week's standalone report)
//   + add/replace a `fourthos-<date>` card in decks.json (section: sponsor-updates)
//   + un-feature older fourthos-* cards so only the newest is highlighted
//   + validate decks.json parses, then git add + commit + push (Pages auto-deploys)
//
// Run after reviewing the preview:  node scripts/fourthos-weekly/promote.mjs
// Options:
//   --date=YYYY-MM-DD   override the dated-folder/card date (default: card.json date or today)
//   --dry-run           no writes, no git
//   --no-push           commit locally but don't push
//   --repo=<path>       decks repo location (default below)
//
// The preview may contain `card.json` { tag, title, description, meta, date } written by the
// generate step; if absent, sensible defaults are used.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_REPO = "C:/Users/david.hayes/Projects/ai-enablement-decks";
const SECTION = "sponsor-updates";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const PUSH = !args.includes("--no-push");
const repoArg = args.find((a) => a.startsWith("--repo="));
const dateArg = args.find((a) => a.startsWith("--date="));
const REPO = (repoArg ? repoArg.split("=")[1] : DEFAULT_REPO).replace(/\\/g, "/");

const deckDir = path.join(REPO, "fourthos");
const previewDir = path.join(deckDir, "preview");
const decksJsonPath = path.join(REPO, "decks.json");

const log = (m) => console.log(`[promote] ${m}`);
const die = (m) => { console.error(`[promote] FAILED: ${m}`); process.exit(1); };

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function humanDate(iso) {
  const [y, m, dd] = iso.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${dd} ${months[m - 1]} ${y}`;
}
function git(cwd, ...a) {
  return execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
}

// --- Pre-flight ----------------------------------------------------------
if (!fs.existsSync(REPO)) die(`decks repo not found at ${REPO} (pass --repo=<path>)`);
if (!fs.existsSync(decksJsonPath)) die(`decks.json not found at ${decksJsonPath}`);
if (!fs.existsSync(previewDir)) die(`no staged preview at ${previewDir} — run a generate first`);
if (fs.existsSync(path.join(previewDir, "_ERROR.md"))) {
  die(`preview/_ERROR.md present — last generate failed. Inspect it; do not promote.`);
}
const allPreview = fs.readdirSync(previewDir);
if (!allPreview.includes("index.html")) {
  die(`preview/ has no index.html — incomplete generate, refusing to promote`);
}

// Optional card metadata written by the generate step.
let card = {};
const cardJsonPath = path.join(previewDir, "card.json");
if (fs.existsSync(cardJsonPath)) {
  try { card = JSON.parse(fs.readFileSync(cardJsonPath, "utf8")); }
  catch (e) { die(`preview/card.json is not valid JSON: ${e.message}`); }
}

const date = (dateArg ? dateArg.split("=")[1] : null) || card.date || todayStamp();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die(`bad date "${date}" — expected YYYY-MM-DD`);

const datedDir = path.join(deckDir, date);
const previewFiles = allPreview.filter((n) => n !== "card.json"); // card.json is metadata, not a page

log(`repo=${REPO}`);
log(`promoting preview -> fourthos/${date}/ (${previewFiles.length} files)${DRY ? "  [DRY RUN]" : ""}`);

// --- 1) Copy preview/* (minus card.json) -> fourthos/<date>/ -------------
if (!DRY) {
  fs.rmSync(datedDir, { recursive: true, force: true }); // idempotent re-promote of same date
  fs.mkdirSync(datedDir, { recursive: true });
  for (const name of previewFiles) {
    fs.cpSync(path.join(previewDir, name), path.join(datedDir, name), { recursive: true });
  }
  fs.rmSync(previewDir, { recursive: true, force: true }); // clear staging
}

// --- 2) Upsert the decks.json card (section: sponsor-updates) ------------
const manifest = JSON.parse(fs.readFileSync(decksJsonPath, "utf8"));
if (!manifest.sections.some((s) => s.id === SECTION)) {
  // Ensure the section exists and sits first.
  manifest.sections.unshift({ id: SECTION, title: "Sponsor Updates", chronological: true, collapsible: true });
  log(`added missing "${SECTION}" section to decks.json (top)`);
}
// Only the newest card is featured.
manifest.decks.forEach((d) => { if (d.section === SECTION) d.featured = false; });

const newCard = {
  id: `fourthos-${date}`,
  section: SECTION,
  tag: card.tag || "Sponsor Update",
  title: card.title || `FourthOS — ${humanDate(date)}`,
  description: card.description ||
    "Weekly portfolio briefing for Carly and Christian — status, sponsor actions, risk radar, outcomes, and a flagship deep-dive.",
  href: `./fourthos/${date}/`,
  meta: card.meta || humanDate(date),
  date,
  status: "shipped",
  featured: true,
};
const existingIdx = manifest.decks.findIndex((d) => d.id === newCard.id);
if (existingIdx >= 0) { manifest.decks[existingIdx] = newCard; log(`replaced existing card ${newCard.id}`); }
else { manifest.decks.unshift(newCard); log(`added card ${newCard.id}`); }

const serialized = JSON.stringify(manifest, null, 2) + "\n";
JSON.parse(serialized); // validate before writing — a broken manifest blanks the whole hub
if (!DRY) fs.writeFileSync(decksJsonPath, serialized);

// --- 3) Commit + push ----------------------------------------------------
if (DRY) { log("DRY RUN complete — no files written, no git actions taken."); process.exit(0); }
try {
  git(REPO, "add", "fourthos/", "decks.json");
  git(REPO, "commit", "-m", `fourthos: publish sponsor update ${date}`);
  log("committed.");
  if (PUSH) {
    git(REPO, "push");
    log("pushed to main — GitHub Pages will deploy.");
    log("verify: gh run list --repo Rev4nchist/ai-enablement-decks --limit 3");
    log(`live card: https://rev4nchist.github.io/ai-enablement-decks/#${SECTION}`);
    log(`live deck: https://rev4nchist.github.io/ai-enablement-decks/fourthos/${date}/`);
  } else {
    log("--no-push: committed locally, not pushed.");
  }
} catch (e) {
  die(`git step failed: ${e.message}`);
}

log("OK");
