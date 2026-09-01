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
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { artifactUrlForType, loadIds } from "../report-registry/artifact-url.mjs";

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
  // Rewrite staged preview links to the dated path. The preview stages with working
  // /fourthos/preview/ nav for review; once promoted, preview/ is cleared (below), so
  // verbatim /fourthos/preview/ links in the dated deck would 404. Swap them to the
  // dated path so promoted cross-tier navigation resolves.
  const rewriteLinks = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { rewriteLinks(p); continue; }
      if (!ent.name.endsWith(".html")) continue;
      const before = fs.readFileSync(p, "utf8");
      const after = before.split("/fourthos/preview/").join(`/fourthos/${date}/`);
      if (after !== before) fs.writeFileSync(p, after);
    }
  };
  rewriteLinks(datedDir);
  log(`rewrote /fourthos/preview/ -> /fourthos/${date}/ in staged HTML`);
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
let commitSha = null;
try {
  git(REPO, "add", "fourthos/", "decks.json");
  git(REPO, "commit", "-m", `fourthos: publish sponsor update ${date}`);
  commitSha = git(REPO, "rev-parse", "--short", "HEAD");
  log("committed.");
  if (PUSH) {
    git(REPO, "push");
    log("pushed to main.");
    // NO Pages verification. The repo went private ~2026-08-06, which deletes Pages on
    // the free tier, and it cannot be made public again. Deploys fail by design and the
    // github.io URLs are HTTP 404 -- printing them told the operator to check a dead link.
    // Git is still the version store; only publishing moved.
  } else {
    log("--no-push: committed locally, not pushed.");
  }
} catch (e) {
  die(`git step failed: ${e.message}`);
}

// --- 4) Report Runs registry row (non-fatal, OBSERVABILITY ONLY) ---------
// Records the promotion with the FINAL dated URL (the preview row upserted by the
// scheduled generate job still points at fourthos/preview/, which is cleared by
// step 1 above — leaving that row's link dead once promoted). Only meaningful once
// the dated deck is actually live (pushed); a --no-push local commit has nothing
// public to link to yet, so the registry step is skipped in that case. This step
// can NEVER change promote's exit code — any failure here is caught and logged.
if (PUSH) {
  try {
    const nodeExe = fs.existsSync("C:/Program Files/nodejs/node.exe")
      ? "C:/Program Files/nodejs/node.exe"
      : process.execPath;
    const registryDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "report-registry");
    const makeRunPath = path.join(registryDir, "make-run.mjs");
    const upsertPath = path.join(registryDir, "upsert.mjs");
    // Matches make-run.mjs's tempRunPath() precedence exactly (TEMP/TMP env win,
    // then os.tmpdir()) so this path always lines up with what make-run actually writes.
    const tmpDir = process.env.TEMP || process.env.TMP || os.tmpdir();
    const runEmitPath = path.join(tmpDir, "report-run-FourthOS-Weekly.json");
    if (fs.existsSync(runEmitPath)) fs.rmSync(runEmitPath, { force: true });

    // Publish the promoted dated package to the local share folder. This is the step
    // that actually makes a promotion reachable now that Pages is gone: publish-local.mjs
    // rewrites the deck's absolute /ai-enablement-decks/ links to relative and refuses to
    // write if any survive. Non-fatal like the rest of this block -- a promotion that
    // committed and pushed is still a promotion.
    let publishedDir = null;
    try {
      const publishPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "publish-local.mjs");
      const out = execFileSync(nodeExe, [
        publishPath, "--source", path.join(REPO, "fourthos", date), "--date", date,
      ], { cwd: REPO, encoding: "utf8" });
      publishedDir = out.trim().split(/\r?\n/).filter(Boolean).pop() || null;
      if (publishedDir) log(`published locally: ${publishedDir}`);
    } catch (e) {
      log(`local publish failed (non-fatal): ${e.message}`);
    }

    // artifactUrl points at the FourthOS report CHILD PAGE, not the old Pages URL and
    // not the local folder. make-run.mjs rejects a non-http artifactUrl by design
    // ("artifact URLs must outlive promotion") so the folder can never go here, and the
    // Pages URL is a 404 -- recording it would put a dead link in the registry and on
    // the hub. Omitting it entirely (the first pass) left the hub with no link at all.
    // The child page is the canonical http place the artifact is ANNOUNCED, and
    // refresh-pages.mjs keeps its "Current run" callout carrying the folder path.
    // Resolution failure is non-fatal: no link is bad, no ROW is worse.
    let artifactArgs = [];
    try {
      const { url, error } = artifactUrlForType("FourthOS Sponsor", loadIds());
      if (url) artifactArgs = ["--artifactUrl", url];
      else log(`registry: no artifact URL (${error}) -- emitting the row without one`);
    } catch (e) {
      log(`registry: artifact URL lookup failed (${e.message}) -- emitting the row without one`);
    }

    const summary = publishedDir
      ? `promoted: dated deck published to ${publishedDir} (commit ${commitSha || "unknown"})`
      : `promoted: dated deck committed, local publish did not run (commit ${commitSha || "unknown"})`;
    execFileSync(nodeExe, [
      makeRunPath,
      "--type", "FourthOS Sponsor",
      "--source", "FourthOS-Weekly",
      "--period", date,
      "--status", "OK",
      ...artifactArgs,
      "--summary", summary,
    ], { cwd: REPO, encoding: "utf8" });

    if (fs.existsSync(runEmitPath)) {
      execFileSync(nodeExe, [upsertPath, runEmitPath], { cwd: REPO, encoding: "utf8" });
      // NOT artifactUrl -- that binding was removed with the Pages URL and this line
      // still read it, so the success path threw ReferenceError. It is inside the
      // enclosing try/catch, so promote did not crash; it logged "promotion row step
      // FAILED" for a step that had ALREADY succeeded -- a step misreporting its own
      // outcome, which is the exact defect class this lane exists to remove.
      log(`registry: recorded promotion row (${publishedDir || "no artifact URL; local publish only"})`);
    } else {
      log("registry: make-run.mjs emitted no report-run.json — skipping upsert (non-fatal)");
    }
  } catch (e) {
    log(`registry: promotion row step FAILED (non-fatal, promote still succeeded): ${e.message}`);
  }
}

log("OK");
