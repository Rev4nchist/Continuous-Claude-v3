#!/usr/bin/env node
// verify-run.mjs — Deterministically classify the outcome of a fourthos-weekly
// generate run. The claude -p exit code alone cannot distinguish OK from SKIP
// or a silent no-op (all exit 0), so this script derives the status from
// ARTIFACT TRUTH first (the decks repo's fourthos/preview/ state) and the log
// sentinel second. Pure node fs + git; no network, no deps (mirrors promote.mjs).
//
// Usage:
//   node scripts/fourthos-weekly/verify-run.mjs --log <LOG_FILE> --exit <EXIT_CODE> [--repo <path>]
//
// Classification (in order):
//   Failed  - exit != 0, or fourthos/preview/_ERROR.md exists (reason = its first line)
//   OK      - all of index.html + briefing.html + deep-dive.html + card.json present
//             in preview/, committed (git status clean for the path), last commit
//             touching fourthos/preview dated TODAY (a stale leftover preview from
//             a prior week must never masquerade as this week's OK), and the log
//             contains the `fourthos-weekly: OK` sentinel
//   Warn    - artifact present but uncommitted, or fresh artifact without the OK
//             sentinel, or this script's own git probing failed (fail-open, never OK)
//   Skipped - no fresh artifact AND the log contains `fourthos-weekly: SKIP`
//   Failed  - reason=no-artifact otherwise (the silent-no-op class)
//
// Output contract: exactly ONE ASCII stdout line `STATUS|reason` (STATUS in
// OK / Warn / Skipped / Failed — the report-registry status enum) and exit 0
// whenever classification itself succeeded. If this script crashes, the caller
// (.bat) records Warn|verify-crashed — never silently OK.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_REPO = "C:/Users/david.hayes/Projects/ai-enablement-decks";
const REQUIRED_FILES = ["index.html", "briefing.html", "deep-dive.html", "card.json"];

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

// Keep the reason ASCII-only, pipe-free, and cmd-safe: the .bat parses it with
// `for /f delims=|`, echoes it, and passes it inside a quoted --summary argument,
// so strip quote/expansion/redirect metacharacters too (cp1252 crashes and cmd
// quoting breaks are both known failure classes here).
function sanitize(s) {
  return String(s)
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/[|"%^&<>!]/g, "/")
    .trim()
    .slice(0, 120);
}

function emit(status, reason) {
  process.stdout.write(`${status}|${sanitize(reason)}\n`);
  process.exit(0);
}

// Task Scheduler runs with a minimal PATH (the same failure class that forces
// the .bat to resolve an absolute node path), so probe the standard install
// location before trusting bare `git`.
const GIT_EXE = ["C:/Program Files/Git/cmd/git.exe", "C:/Program Files/Git/bin/git.exe"]
  .find((p) => fs.existsSync(p)) || "git";

function git(repo, args) {
  return execFileSync(GIT_EXE, ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

try {
  const logPath = arg("log", "");
  const repo = arg("repo", DEFAULT_REPO).replace(/\\/g, "/");
  const exitCode = Number(arg("exit", "0"));

  // Log text is the sentinel source. A missing/unreadable log just means "no
  // sentinel" — it is not itself a classification failure.
  let logText = "";
  if (logPath) {
    try { logText = fs.readFileSync(logPath, "utf8"); } catch { /* absent */ }
  }
  // Sentinels must be ANCHORED at line start (multiline): the log is claude's
  // full stdout+stderr, which can narrate/quote the contract text (e.g.
  // "- mcp down: `fourthos-weekly: SKIP reason=<short>`"). Only a sentinel the
  // model actually printed as its own output line counts, and only the LAST
  // such line (the contract says the final stdout line is the status).
  const lastLineMatch = (re) => {
    let m = null;
    for (const found of logText.matchAll(re)) m = found;
    return m;
  };
  const okSentinel = lastLineMatch(/^fourthos-weekly:\s*OK\b.*$/gm) !== null;
  const skipMatch = lastLineMatch(/^fourthos-weekly:\s*SKIP\s*(?:reason=(\S+))?.*$/gm);
  const failMatch = lastLineMatch(/^fourthos-weekly:\s*FAILED\s*(?:reason=(\S+))?.*$/gm);

  const previewDir = path.join(repo, "fourthos", "preview");
  const errFile = path.join(previewDir, "_ERROR.md");

  // (a) Hard failures first — regardless of what the sentinel claims.
  if (Number.isFinite(exitCode) && exitCode !== 0) {
    const why = failMatch && failMatch[1] ? failMatch[1] : "exit-nonzero";
    emit("Failed", `${why} (exit=${exitCode})`);
  }
  // _ERROR.md only fails THIS run when it is fresh (written today). A stale
  // _ERROR.md committed by a prior week's Notion outage must not poison every
  // subsequent genuinely-successful run (the generate step is also instructed
  // to delete it on success, but don't rely on that alone).
  if (fs.existsSync(errFile)) {
    let errIsFresh = false;
    try {
      errIsFresh = fs.statSync(errFile).mtime.toISOString().slice(0, 10) === todayStamp();
    } catch { errIsFresh = true; /* unreadable stat: fail safe, treat as fresh */ }
    if (errIsFresh) {
      let first = "_ERROR.md present";
      try {
        first = fs.readFileSync(errFile, "utf8").split(/\r?\n/).find((l) => l.trim()) || first;
      } catch { /* keep default */ }
      emit("Failed", first);
    }
  }

  // (b) Artifact truth.
  const filesPresent =
    fs.existsSync(previewDir) &&
    REQUIRED_FILES.every((f) => fs.existsSync(path.join(previewDir, f)));

  if (filesPresent) {
    // Committed? Present-but-uncommitted is a Warn (the generate step is
    // supposed to commit+push preview/), never a Failed and never an OK.
    let porcelain = null;
    try { porcelain = git(repo, ["status", "--porcelain", "--", "fourthos/preview"]); } catch { /* null */ }
    if (porcelain === null) emit("Warn", "artifact-present git-status-unavailable");
    if (porcelain !== "") emit("Warn", "preview-present-uncommitted");

    // Fresh? EVERY required file's last commit must be dated today — a
    // directory-level check would let a run that touched only card.json pass
    // stale briefing/deep-dive leftovers off as this week's OK.
    let allFresh = true;
    try {
      for (const f of REQUIRED_FILES) {
        const iso = git(repo, ["log", "-1", "--format=%cI", "--", `fourthos/preview/${f}`]);
        if (iso.slice(0, 10) !== todayStamp()) { allFresh = false; break; }
      }
    } catch { allFresh = false; }
    if (allFresh) {
      if (okSentinel) emit("OK", "preview-staged");
      // A fresh artifact PLUS a SKIP sentinel is the stand-down case: an
      // interactive generate already staged this week's package and the
      // scheduled run deliberately declined to rebuild over it. That is a
      // clean Skipped, not a Warn — before the generate prompt grew its
      // step-0 stand-down check, SKIP could only mean "nothing was
      // published", so this combination had no meaning and fell through.
      if (skipMatch) emit("Skipped", skipMatch[1] || "skip");
      // Good artifact, no sentinel at all: downgrade to Warn, not Failed.
      emit("Warn", "artifact-fresh no-ok-sentinel");
    }
    // Present + committed but not today = stale leftover; fall through.
    if (skipMatch) emit("Skipped", skipMatch[1] || "skip");
    emit("Failed", "no-artifact (only a stale preview from a prior run)");
  }

  // (c) No artifact at all.
  if (skipMatch) emit("Skipped", skipMatch[1] || "skip");
  emit("Failed", "no-artifact");
} catch (e) {
  // The classification machinery itself broke — fail open to Warn, never OK.
  const msg = e && e.message ? e.message : String(e);
  process.stdout.write(`Warn|verify-error:${sanitize(msg)}\n`);
  process.exit(0);
}
