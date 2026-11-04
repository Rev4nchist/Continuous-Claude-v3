#!/usr/bin/env node
// P0 fix-diff replay (TREX verify design, section 5, row P0). No model.
// For each bench seeded-bug row S1..S15: take the test files the fix commit adds or changes, run them at the pre SHA (with the
// fix's copy of those files laid over the pre tree) and at the fix SHA, and judge both runs with prove-check.
// A row is "proven" when the tests fire at pre and are clean at fix. A row with nothing runnable is "not attempted", with the reason.
//
// Usage: node scripts/trex/verify/fixdiff-replay.mjs [--rows S9,S4] [--out dir] [--date YYYY-MM-DD]
// Writes <out>/<date>-trex-verify-p0-fixdiff-replay.json and .txt (default out: <repo>/.claude/cache/e2e).
// Trees: <repo>/.claude/cache/proof/<sha8>/oracle0-<row>/ (gitignored). Host only; see oracle0.mjs for why.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRows } from '../bench/rows.mjs';
import { oracleDeps, planFixDiff, rowVerdict, runPlan } from './oracle0.mjs';
import { proveRowInContainer, realContainerDeps, withTrexLock } from './oracle0-container.mjs';
import { makeTrexGit } from '../lib/git.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const IDS = Array.from({ length: 15 }, (_, i) => `S${i + 1}`);
const CLIP = 3000;
const clip = (s) => (s && s.length > CLIP ? `${s.slice(0, CLIP / 2)}\n[... ${s.length - CLIP} chars cut ...]\n${s.slice(-CLIP / 2)}` : s ?? '');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rows') o.rows = argv[++i].split(',');
    else if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--date') o.date = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return o;
}

const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Every failing line of a run, for the reader. The verdict itself comes from prove-check classifyRun, not from this list.
const FAIL_SHAPE = /^\s*(not ok |\(fail\)|\d+\)\s|[✖✘✗×]\s|x\s+\d+\s)/;
const allFailLines = (run) => (`${run.stdout}\n${run.stderr}`).split(/\r?\n/).filter((l) => FAIL_SHAPE.test(l));
const failLines = (run) => allFailLines(run).map((l) => l.trim().slice(0, 220)).slice(0, 40);

// ---------- the seeded test: does the fix's own test fire at pre? ----------
// A row can fire at pre on an unrelated test that already failed (a sibling commit, a flaky spec). Such a row proves nothing about the
// seeded defect. The seeded tests are the tests the fix diff adds or changes; the row counts only when one of them is among the pre failures.

const TEST_DECL = /^\s*(?:test|it)(?:\.(?:only|skip|serial|fixme|slow))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;

/** New-side line numbers added or changed in a `git diff -U0` text. A pure deletion adds none. */
export function addedLineNumbers(diffText) {
  const out = [];
  for (const m of String(diffText ?? '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i += 1) out.push(start + i);
  }
  return out;
}

/**
 * Titles of the tests (`test(` / `it(` first string argument) that hold an added or changed line of the fix-side file.
 * A line is attributed to the nearest test declaration above it, so a helper added between two tests lands on the earlier one.
 */
export function seededTestNames(fixText, added) {
  const decls = [];
  String(fixText ?? '').split(/\r?\n/).forEach((line, i) => {
    const m = TEST_DECL.exec(line);
    if (m) decls.push({ line: i + 1, title: m[2].replace(/\\(.)/g, '$1') });
  });
  const titles = new Set();
  for (const n of added) {
    const d = decls.filter((x) => x.line <= n).at(-1);
    if (d) titles.add(d.title);
  }
  return [...titles];
}

const escapeRe = (s) => s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
/** A title as a regex: a `${...}` placeholder of a template title matches any text. */
const titleRe = (title) => new RegExp(title.split(/\$\{[^}]*\}/).map(escapeRe).join('.+?'));

/** true: a seeded title is in a failing line of the pre run. false: pre fails, but not on a seeded test. null: no title could be read. */
export function seededFires(names, runText) {
  if (!names || names.length === 0) return null;
  // node --test TAP escapes "#" and "\" in a test name (`\#225`); undo that before the title is looked up.
  const lines = String(runText ?? '').split(/\r?\n/).filter((l) => FAIL_SHAPE.test(l)).map((l) => l.replace(/\\([\\#])/g, '$1'));
  return names.some((n) => lines.some((l) => titleRe(n).test(l)));
}

function seededNamesOf(files, row) {
  const git = (args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const names = new Set();
  for (const f of files) {
    const diff = git(['diff', '-U0', row.pre, row.fix, '--', f]);
    const text = git(['show', `${row.fix}:${f}`]);
    if (diff.status !== 0 || text.status !== 0) continue;
    for (const n of seededTestNames(text.stdout, addedLineNumbers(diff.stdout))) names.add(n);
  }
  return [...names];
}

// ---------- counts and the gate ----------

/**
 * Counts and the gate. A row with `sharedWith` reuses another row's run (same fix diff), so it is in the raw counts only.
 * The gate reads the unique counts: >= 9 proven and proven / attempted >= 9/11. The label shows the real denominator.
 * @param {Array<{ attempted: boolean, proven: boolean, sharedWith?: string }>} rows
 */
export function summarizeRows(rows) {
  const unique = rows.filter((r) => !r.sharedWith);
  const count = (list) => ({ attempted: list.filter((r) => r.attempted).length, proven: list.filter((r) => r.attempted && r.proven).length });
  const raw = count(rows);
  const uniq = count(unique);
  const pass = uniq.proven >= 9 && uniq.proven * 11 >= uniq.attempted * 9;
  return {
    rawAttempted: raw.attempted, rawProven: raw.proven, uniqueAttempted: uniq.attempted, uniqueProven: uniq.proven,
    gate: pass ? 'PASS' : 'FAIL',
    gateLabel: `${uniq.proven} of ${uniq.attempted} attempted unique rows proven (need >= 9 proven and >= 9/11 of attempted)`,
  };
}

const sub = (r) => ({
  major: r.major, ok: r.ok, reasons: r.reasons, setupError: r.setupError ?? false, note: r.note,
  pre: r.pre && { sha: r.pre.sha, verdict: r.pre.verdict, fireLine: r.pre.fireLine, why: r.pre.why, code: r.pre.code, cmd: r.pre.cmd, copied: r.pre.copied.map((c) => c.to) },
  fix: r.fix && { sha: r.fix.sha, verdict: r.fix.verdict, fireLine: r.fix.fireLine, why: r.fix.why, code: r.fix.code, cmd: r.fix.cmd },
  failLines: r.raw && { pre: failLines(r.raw.pre), fix: failLines(r.raw.fix) },
  tail: r.raw && { pre: clip(`${r.raw.pre.stdout}\n${r.raw.pre.stderr}`.trim()), fix: clip(`${r.raw.fix.stdout}\n${r.raw.fix.stderr}`.trim()) },
});

async function replayRow(row, deps, containerRun, sharedFrom) {
  const plan = planFixDiff(REPO, row);
  const head = { row: row.major, pre: plan.pre, fix: plan.fix, commits: plan.commits, changed: plan.changed, overlay: plan.overlay, skipped: plan.skipped };
  if (sharedFrom) return { ...head, attempted: sharedFrom.attempted, sharedWith: sharedFrom.row, verdict: sharedFrom.verdict, seededFires: sharedFrom.seededFires, proven: sharedFrom.proven, subrows: sharedFrom.subrows };
  if (!plan.attempted) return { ...head, attempted: false, proven: false, why: plan.why, subrows: [] };
  const results = await runPlan(plan, deps, containerRun);
  const subrows = results.map((r, i) => {
    const seededNames = seededNamesOf(plan.groups[i]?.files ?? [], row);
    return { ...sub(r), seededNames, seededFires: r.raw ? seededFires(seededNames, allFailLines(r.raw.pre).join('\n')) : null };
  });
  const verdict = rowVerdict(results);
  const fires = rowSeededFires(subrows);
  const out = { ...head, attempted: true, verdict, seededFires: fires, proven: verdict.proven && fires === true, subrows };
  if (plan.commits > 1 && !plan.groups.some((g) => g.container)) out.tight = await tightCheck(row, deps);
  return out;
}

// The seeded test fired at pre in an ok sub-row: true. Only other tests fired: false. No test title could be read: null.
function rowSeededFires(subrows) {
  const ok = subrows.filter((s) => s.ok);
  const list = ok.length > 0 ? ok : subrows;
  if (list.some((s) => s.seededFires === true)) return true;
  return list.every((s) => s.seededFires === null) ? null : false;
}

// A range of several commits: the fire may come from a sibling commit. Re-run with pre = the parent of the fix commit, so only the
// last commit's own tests are in play. Supplementary: it is not part of the gate count.
async function tightCheck(row, deps) {
  const parent = spawnSync('git', ['-C', REPO, 'rev-parse', `${row.fix}^`], { encoding: 'utf8' }).stdout.trim();
  const plan = planFixDiff(REPO, { ...row, pre: parent });
  if (!plan.attempted) return { pre: parent, attempted: false, why: plan.why };
  const results = await runPlan(plan, deps, undefined);
  return { pre: parent, attempted: true, verdict: rowVerdict(results), subrows: results.map(sub) };
}

function rowDetail(r) {
  if (!r.attempted) return `skipped: ${r.why}`;
  const shared = r.sharedWith ? ` (same fix diff as ${r.sharedWith}, one run)` : '';
  if (r.proven) return `fire@pre on the seeded test, clean@fix: ${r.verdict.why}${shared}`;
  if (r.verdict.proven) return `NOT proven: fire@pre but seededFires=${r.seededFires} (${r.seededFires === null ? 'no seeded test title could be read' : 'pre fails only on tests the fix diff did not touch'}): ${r.verdict.why}${shared}`;
  return `NOT proven: ${r.verdict.why}${shared}`;
}

function summaryText(rows, summary) {
  const lines = [`TREX verify P0 fix-diff replay  head ${summary.head}  ${summary.date}`, ''];
  lines.push('row   attempted  proven  detail');
  for (const r of rows) {
    lines.push(`${r.row.padEnd(5)} ${String(r.attempted).padEnd(10)} ${String(r.attempted ? r.proven : '-').padEnd(7)} ${rowDetail(r)}  [range: ${r.commits} commit${r.commits === 1 ? '' : 's'}]`);
    if (r.tight) lines.push(`        tight check (pre = parent of the fix commit ${r.tight.pre.slice(0, 8)}): ${r.tight.attempted ? (r.tight.verdict.proven ? 'fire@pre, clean@fix' : `NOT proven: ${r.tight.verdict.why}`) : `not run: ${r.tight.why}`}`);
    for (const s of r.subrows ?? []) {
      lines.push(`        ${s.major}: seededFires=${s.seededFires} pre=${s.pre?.verdict ?? 'n/a'}${s.pre?.fireLine ? ` "${s.pre.fireLine}"` : ''}${s.pre?.why ? ` (${s.pre.why})` : ''} (${s.failLines?.pre.length ?? 0} failing lines at pre) fix=${s.fix?.verdict ?? 'n/a'}${s.fix?.why ? ` (${s.fix.why})` : ''}${s.setupError ? ` setup: ${s.reasons.join('; ')}` : ''}`);
    }
  }
  lines.push('', `raw: attempted ${summary.rawAttempted} of ${summary.rows}, proven ${summary.rawProven} (a row that shares another row's run counts again)`);
  lines.push(`unique: attempted ${summary.uniqueAttempted}, proven ${summary.uniqueProven}`);
  lines.push(`gate: ${summary.gateLabel}: ${summary.gate}`);
  return `${lines.join('\n')}\n`;
}

export async function main(argv) {
  const o = parseArgs(argv);
  const all = loadRows(path.join(REPO, 'scripts', 'trex', 'bench', 'proofs-trex.json'));
  const ids = o.rows ?? IDS;
  const deps = oracleDeps({ repo: REPO });
  const done = new Map();
  const cdeps = realContainerDeps(makeTrexGit(REPO), REPO);
  const rows = [];
  for (const id of ids) {
    const row = all.find((r) => r.major === id);
    if (!row) throw new Error(`no bench row ${id}`);
    const key = `${row.pre}..${row.fix}`;
    const out = await replayRow(row, deps, (r) => withTrexLock(cdeps, () => proveRowInContainer(r, cdeps)), done.get(key));
    if (!done.has(key) && out.attempted) done.set(key, { row: id, ...out });
    process.stdout.write(`${id}: ${out.attempted ? (out.proven ? 'proven' : 'NOT proven') : 'not attempted'}${out.attempted ? ` (seededFires ${out.seededFires})` : ''}\n`);
    rows.push(out);
  }
  const date = o.date ?? localDate();
  const summary = { head: spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), date, rows: rows.length, ...summarizeRows(rows), notAttempted: rows.filter((r) => !r.attempted).map((r) => ({ row: r.row, why: r.why })) };
  const out = path.resolve(o.out ?? path.join(REPO, '.claude', 'cache', 'e2e'));
  mkdirSync(out, { recursive: true });
  const stem = path.join(out, `${date}-trex-verify-p0-fixdiff-replay`);
  writeFileSync(`${stem}.json`, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  writeFileSync(`${stem}.txt`, summaryText(rows, summary));
  process.stdout.write(`${stem}.json\nraw attempted ${summary.rawAttempted}, proven ${summary.rawProven}; unique attempted ${summary.uniqueAttempted}, proven ${summary.uniqueProven}; gate ${summary.gate}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
