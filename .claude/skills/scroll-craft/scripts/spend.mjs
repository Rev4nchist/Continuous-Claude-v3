#!/usr/bin/env node
/**
 * scrollcraft spend ledger (CCv3 addition).
 *
 * kie.mjs appends one row per paid job to <workspace>/kie-spend.jsonl with the
 * account balance read before and after it (the probe is free). The report
 * sums a build's rows so BUILD-REPORT.md can state what the page cost.
 *
 *   node spend.mjs                      totals for every build
 *   node spend.mjs --build <name>       one build's rows and total
 *
 * A balance delta is only this job's cost when nothing else spends against the
 * same key at the same time (see references/assets.md). Rows record both
 * balances so a reader can see when a delta is suspect.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function ledgerPath() {
  const home = process.env.SCROLLCRAFT_HOME;
  return path.join(home ? path.resolve(home) : process.cwd(), "kie-spend.jsonl");
}

// "…/builds/<name>/…" names the build; anything else is filed under "(none)".
export function buildOf(file) {
  const parts = path.resolve(file).split(path.sep);
  const i = parts.lastIndexOf("builds");
  return i > -1 && parts[i + 1] ? parts[i + 1] : "(none)";
}

export function appendSpend(row, file = ledgerPath()) {
  const before = row.creditsBefore, after = row.creditsAfter;
  const spent = Number.isFinite(before) && Number.isFinite(after) ? +(before - after).toFixed(2) : null;
  const full = { ts: new Date().toISOString(), ...row, spent };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(full) + "\n");
  return full;
}

export function readSpend(file = ledgerPath()) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

export function totals(rows) {
  const by = {};
  for (const r of rows) {
    const b = (by[r.build] ||= { build: r.build, jobs: 0, stills: 0, shots: 0, spent: 0, unmeasured: 0 });
    b.jobs++;
    if (r.cmd === "still") b.stills++;
    if (r.cmd === "shot") b.shots++;
    if (Number.isFinite(r.spent)) b.spent = +(b.spent + r.spent).toFixed(2);
    else b.unmeasured++;
  }
  return Object.values(by);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--build");
  const want = i > -1 ? argv[i + 1] : null;
  const rows = readSpend().filter((r) => !want || r.build === want);
  console.log(`ledger: ${ledgerPath()}`);
  if (!rows.length) { console.log("no paid jobs recorded"); process.exit(0); }
  if (want) for (const r of rows) console.log(`  ${r.ts}  ${r.cmd.padEnd(5)}  ${String(r.spent ?? "?").padStart(6)}  ${r.out}`);
  for (const t of totals(rows)) {
    console.log(`${t.build}: ${t.jobs} jobs (${t.stills} stills, ${t.shots} shots), ${t.spent} credits` +
      (t.unmeasured ? `, ${t.unmeasured} unmeasured` : ""));
  }
}
