// reconcile.mjs — recover runs that happened but never reached the registry.
//
// WHY THIS EXISTS, with a specimen rather than a hypothesis. On 2026-07-27 the
// Project-Cards sweep exited 0 and refreshed 10 cards, and the registry has no
// Project Portfolio row for that day: the pre-emit's Notion write died on
// `ntn spawnSync ETIMEDOUT` and was swallowed as non-fatal, then the machine
// crashed before anything wrote a completion. The local $TEMP artifact survived,
// carrying its runId. (Preserved at .claude/logs/phase0-artifacts/.)
//
// That is the whole idea: RECORDING THAT A RUN HAPPENED and REACHING NOTION AT
// THAT INSTANT are two different jobs, and the always-emit contract coupled them.
// The artifact is written locally first and is durable; this sweeps whatever the
// network lost.
//
// CLI (D6, decided 2026-08-02 — default is report-only + delete-nothing):
//   node scripts/report-registry/reconcile.mjs                 # DRY RUN: report what would change
//   node scripts/report-registry/reconcile.mjs --apply         # actually repair + clean confirmed artifacts
//   node scripts/report-registry/reconcile.mjs --apply --keep  # repair but never delete artifacts
//   node scripts/report-registry/reconcile.mjs --max-age-days 14
//
// Exit codes: 0 nothing to do or all repaired · 1 at least one artifact failed.
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { queryDataSource } from '../project-cards/lib/notion.mjs';
import { upsertReportRun, validateRun } from './upsert.mjs';
import { REPORT_RUNS_DS_ID } from './config.mjs';

export const ARTIFACT_RE = /^report-run-.+\.json$/;
export const DEFAULT_MAX_AGE_DAYS = 7;
// An artifact younger than this may belong to a run still in flight, so it is
// never deleted even once its row is confirmed. Reconciling it is still safe —
// that is absent-only — but removing its evidence out from under a live pipeline
// is not.
export const CLEAN_GRACE_HOURS = 24;

const MS_DAY = 86_400_000;
const MS_HOUR = 3_600_000;

// --- the load-bearing rule -------------------------------------------------------
// ABSENT-ONLY. A pre-emit artifact shares its runId with the row the completed run
// later UPDATES in place, so a blind upsert would regress a finished `OK` row back
// to the pre-emit's `Failed / in-progress`. That is the single most dangerous thing
// this file could do — it would turn a reporting gap into reporting corruption, and
// it would look like the tool working. So: query first, and write ONLY when the
// registry has no row for that runId at all.
export function decide(run, existingRows, { now, maxAgeDays = DEFAULT_MAX_AGE_DAYS, mtimeMs }) {
  const ageMs = artifactAgeMs(run, { now, mtimeMs });
  if (ageMs > maxAgeDays * MS_DAY) {
    return { action: 'skip', reason: `older than ${maxAgeDays}d (${Math.floor(ageMs / MS_DAY)}d)` };
  }
  if (existingRows.length > 0) {
    return {
      action: 'present',
      reason: `registry already has ${existingRows.length} row(s) — NOT touched`,
      cleanable: ageMs > CLEAN_GRACE_HOURS * MS_HOUR,
    };
  }
  return { action: 'repair', reason: 'no row for this runId' };
}

// Prefer the run's own runDate — it is when the run happened, which is what the age
// bound is about. File mtime is the fallback, and it is only a proxy: a re-read or a
// backup restore moves it.
export function artifactAgeMs(run, { now, mtimeMs }) {
  const t = Date.parse(run?.runDate || '');
  const basis = Number.isNaN(t) ? mtimeMs : t;
  if (!Number.isFinite(basis)) return 0;
  return Math.max(0, now - basis);
}

export function listArtifacts(dir, { readdir = readdirSync } = {}) {
  return readdir(dir).filter((f) => ARTIFACT_RE.test(f)).sort();
}

export function parseArgs(argv) {
  // D6 (decided 2026-08-02): default is REPORT-ONLY and DELETE-NOTHING. The
  // operator reaching for a recovery tool is mid-incident; the safe default is
  // to show what would change. --apply opts into writes + cleanup; an explicit
  // --keep still suppresses deletion under --apply.
  const out = { dryRun: true, keep: true, maxAgeDays: DEFAULT_MAX_AGE_DAYS, dir: process.env.TEMP || tmpdir() };
  let apply = false;
  let explicitKeep = false;
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--keep') explicitKeep = true;
    else if (a === '--max-age-days') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--max-age-days needs a positive number');
      out.maxAgeDays = n;
    } else if (a === '--dir') out.dir = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
  }
  if (apply && explicitDryRun) throw new Error('--apply and --dry-run contradict each other — pick one');
  if (apply) {
    out.dryRun = false;
    out.keep = explicitKeep;
  }
  return out;
}

// --- sweep -----------------------------------------------------------------------
export function reconcile({
  dir,
  dryRun = false,
  keep = false,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  now = Date.now(),
  read = (p) => readFileSync(p, 'utf8'),
  stat = statSync,
  readdir = readdirSync,
  query = queryDataSource,
  upsert = upsertReportRun,
  remove = unlinkSync,
  log = console.log,
  warn = console.error,
} = {}) {
  const files = listArtifacts(dir, { readdir });
  const result = { scanned: files.length, repaired: [], present: [], skipped: [], failed: [], cleaned: [] };

  for (const f of files) {
    const path = join(dir, f);
    let run;
    try {
      run = JSON.parse(read(path));
      validateRun(run);
    } catch (e) {
      // A malformed artifact is reported, never fatal — one bad file must not stop
      // the sweep that is recovering the others.
      result.failed.push({ file: f, error: `unreadable/invalid: ${e.message}` });
      warn(`[reconcile] SKIP ${f} — ${e.message}`);
      continue;
    }

    let mtimeMs;
    try { mtimeMs = stat(path).mtimeMs; } catch { mtimeMs = undefined; }

    let rows;
    try {
      rows = query(REPORT_RUNS_DS_ID, {
        filter: { property: 'Run ID', rich_text: { equals: String(run.runId) } },
      }) || [];
    } catch (e) {
      result.failed.push({ file: f, error: `registry query failed: ${e.message}` });
      warn(`[reconcile] FAIL ${f} — could not check the registry: ${e.message}`);
      continue;
    }

    const d = decide(run, rows, { now, maxAgeDays, mtimeMs });

    if (d.action === 'skip') {
      result.skipped.push({ file: f, runId: run.runId, reason: d.reason });
      log(`  skip    ${f} — ${d.reason}`);
      continue;
    }

    if (d.action === 'present') {
      result.present.push({ file: f, runId: run.runId });
      log(`  present ${f} — ${d.reason}`);
      if (!keep && !dryRun && d.cleanable) {
        try { remove(path); result.cleaned.push(f); log(`          cleaned (row confirmed, artifact older than ${CLEAN_GRACE_HOURS}h)`); } catch (e) {
          warn(`[reconcile] WARN could not remove ${f} (non-fatal): ${e.message}`);
        }
      }
      continue;
    }

    if (dryRun) {
      result.repaired.push({ file: f, runId: run.runId, dryRun: true });
      log(`  REPAIR  ${f} — ${run.type} ${run.period} status=${run.status} (would create)`);
      continue;
    }

    try {
      const r = upsert(run);
      result.repaired.push({ file: f, runId: run.runId, action: r.action, pageId: r.pageId });
      log(`  REPAIR  ${f} — ${r.action} ${r.pageId} (${run.type} ${run.period} status=${run.status})`);
    } catch (e) {
      result.failed.push({ file: f, error: `upsert failed: ${e.message}` });
      warn(`[reconcile] FAIL ${f} — ${e.message}`);
    }
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n[reconcile] sweeping ${args.dir} for report-run artifacts${args.dryRun ? ' (DRY RUN)' : ''}`);
  const r = reconcile(args);
  console.log(
    `\nscanned ${r.scanned} · repaired ${r.repaired.length} · already present ${r.present.length}`
    + ` · skipped ${r.skipped.length} · failed ${r.failed.length} · cleaned ${r.cleaned.length}`,
  );
  if (r.repaired.length) {
    console.log('\nRuns that had happened and the registry did not know about:');
    for (const x of r.repaired) console.log(`  ${x.runId}`);
    if (args.dryRun) console.log('\nDRY RUN — nothing was written. Re-run with --apply to repair.');
  }
  if (r.failed.length) {
    console.error(`\n${r.failed.length} artifact(s) failed:`);
    for (const x of r.failed) console.error(`  ${x.file}: ${x.error}`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { console.error(`[reconcile] FATAL: ${e.message}`); process.exit(1); });
}
