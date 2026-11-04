#!/usr/bin/env node
/**
 * land-none-check.mjs - the land gate for a review:none PR at band HIGH or CRITICAL (lane agent-self-approve-hole, Dave 2026-11-03: DETECT).
 *
 * Anyone with write access can add the review:none label, and the pr-checkpoint engine takes `--by dave` at every band. So the label and the
 * router state alone do not show that Dave chose "no review". The pr-checkpoint mod stores how he chose (`via`) in its plugin store. This check
 * reads that record before land-pr.ps1 merges. It passes only for Dave's own pick (dialog or composer) on this exact head, at a band that did
 * not rise since. It prints one provenance line, so Dave sees who chose what before he says land.
 *
 * Usage: node scripts/github/land-none-check.mjs <pr> --repo <o/r> --head <sha> [--store <file>] [--fixture <file>] [--warn] [--json]
 *   --store    one store file instead of ~/.claude/plugins/store/ccv3-mods_*.json (tests).
 *   --fixture  { pull, files, config }: no gh call (tests and the probe).
 *   --warn     print the same text but always exit 0 (land-pr.ps1 -IgnoreReview: Dave's own yes, made informed).
 * Exit: 0 = ok or not needed, 1 = refused, 2 = could not determine.
 * The files and labels come from the live PR; the band config comes from the base ref through the contents API, never the local checkout.
 * Not covered, accepted: an agent that writes a forged record from a script that builds the path in code. Docs: pr-review-loop.md, land section.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandOf, changedPaths, DEFAULT_REPO, loadLive, makeGh } from './review-router.mjs';
import { pullLabelNames } from './review-status.mjs';

const RANK = { LOW: 0, MID: 1, ELEVATED: 2, HIGH: 3, CRITICAL: 4 };
const NEEDS_RECORD = new Set(['HIGH', 'CRITICAL']);
const PICKED_BY_DAVE = new Set(['dialog', 'composer']);
const rankOf = (band) => RANK[band] ?? -1;
const sha7 = (sha) => String(sha ?? '').slice(0, 7) || 'none';

const ZONE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
/** `2026-11-03 21:42 CST`, or null when `at` is not a date. Dave's zone is America/Chicago: CST in winter, CDT in summer. */
export function localTime(at) {
  const date = new Date(at);
  if (typeof at !== 'string' || Number.isNaN(date.getTime())) return null;
  const p = Object.fromEntries(ZONE.formatToParts(date).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** Why one store record does not prove Dave's pick for this PR, head and band, or null when it does. The first failing rule wins. */
function recordProblem(v, { pr, head, band }) {
  if (v === undefined) return `no checkpoint:pr:${pr} record`;
  if (v === null || typeof v !== 'object') return `the checkpoint:pr:${pr} record is not an object`;
  if (v.pr !== pr) return `the record is for PR ${v.pr}, not #${pr}`;
  if (v.pathway !== 'none' || v.label !== 'review:none') return `the record holds ${v.pathway}/${v.label}, not none/review:none`;
  if (v.decided_by !== 'dave') return `decided_by is ${v.decided_by}, not dave`;
  if (!PICKED_BY_DAVE.has(v.via)) return `via is ${v.via ?? 'missing'}; only a pick in Dave's dialog or composer counts`;
  if (v.head !== head) return `the record is for head ${sha7(v.head)}, the PR head is ${sha7(head)}; a push after the pick makes it stale`;
  if (rankOf(v.band) < 0) return 'the record has no band';
  if (rankOf(band) > rankOf(v.band)) return `the band is ${band} now and was ${v.band} at the pick`;
  if (localTime(v.at) === null) return `the record's at is not a date (${JSON.stringify(v.at)})`;
  return null;
}

const skip = (reason) => ({ needed: false, ok: true, line: null, problem: null, reason });
const refuse = (problem, undetermined = false) => ({ needed: true, ok: false, undetermined, line: null, problem });

/** Problems from the store files that could not be read: named, so Dave knows which file broke. */
const storeProblems = (found) => [
  ...(found.files.length === 0 ? [`no plugin store file found (looked for ${found.glob})`] : []),
  ...found.bad.map((b) => `store file ${b.file} is not valid JSON (${b.error})`),
];

/**
 * nonePick({ pr, head, labels, band, read }) -> { needed, ok, line, problem, undetermined?, reason? }
 *   band: the live band name (bandOf(...)?.band) or null. head: the PR head sha.
 *   read: () => { glob, files, records: [{ file, value }], bad: [{ file, error }] }. Called only when a record is needed.
 * Not needed: no review:none label, or band LOW, MID or ELEVATED. A null band with review:none is undetermined (fail closed).
 */
export function nonePick({ pr, head, labels = [], band = null, read }) {
  if (!labels.includes('review:none')) return skip('the PR has no review:none label');
  if (band === null || band === undefined || rankOf(band) < 0) return refuse('the review band could not be computed from the base config, so the none pick cannot be checked', true);
  if (!NEEDS_RECORD.has(band)) return skip(`band ${band} needs no record`);
  const found = read();
  const checked = found.records.map((r) => ({ ...r, problem: recordProblem(r.value, { pr, head, band }) }));
  const good = checked.find((r) => r.problem === null);
  if (good) return { needed: true, ok: true, problem: null, line: `Dave chose none at ${localTime(good.value.at)} via ${good.value.via}, head ${sha7(head)} (band ${band}, store ${good.file})` };
  const problems = [...storeProblems(found), ...checked.map((r) => `${r.file}: ${r.problem}`)];
  return refuse(problems.join('; '));
}

// ---------- the store ----------

const STORE_NAME = /^ccv3-mods_.*\.json$/;
const defaultStoreDir = () => path.join(os.homedir(), '.claude', 'plugins', 'store');

/** The store files to read: the one named, else every ccv3-mods_*.json in the plugin store folder. */
export function storeFiles(storeArg, dir = defaultStoreDir()) {
  if (storeArg) return { glob: storeArg, files: existsSync(storeArg) ? [storeArg] : [] };
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => STORE_NAME.test(n)).map((n) => path.join(dir, n)) : [];
  return { glob: path.join(dir, 'ccv3-mods_*.json'), files };
}

/** A reader for nonePick. Each file is parsed alone; a file that is not JSON goes to `bad`. */
export function makeReader(pr, storeArg) {
  return () => {
    const { glob, files } = storeFiles(storeArg);
    const records = [];
    const bad = [];
    for (const file of files) {
      try {
        records.push({ file, value: JSON.parse(readFileSync(file, 'utf8'))?.[`checkpoint:pr:${pr}`] });
      } catch (err) {
        bad.push({ file, error: String(err.message).split('\n')[0] });
      }
    }
    return { glob, files, records, bad };
  };
}

// ---------- inputs ----------

const flag = (args, k) => args.includes(k);
const opt = (args, k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

/** The router config of the base branch, through the contents API: a PR must not lower its own bar, and the local checkout may be on another branch. */
function baseConfig(gh, repo, pull) {
  const file = gh(['api', `repos/${repo}/contents/review-router.config.json?ref=${encodeURIComponent(pull.base.ref)}`]);
  return JSON.parse(Buffer.from(file.content ?? '', 'base64').toString('utf8'));
}

function load(args, repo, pr) {
  const fixture = opt(args, '--fixture');
  if (fixture) return JSON.parse(readFileSync(fixture, 'utf8'));
  const gh = makeGh();
  const { pull, files } = loadLive(gh, repo, pr);
  return { pull, files, config: baseConfig(gh, repo, pull) };
}

// ---------- main ----------

function report(res, { pr, warn, json }) {
  if (json) console.log(JSON.stringify({ pr, warn, ...res }));
  else if (res.ok && res.needed) console.log(res.line);
  else if (res.ok) console.log(`land-none-check: PR #${pr} needs no record (${res.reason})`);
  else console.log(`${warn ? 'WARNING' : 'REFUSED'}: PR #${pr} review:none pick is not on record: ${res.problem}`);
  if (res.ok || warn) return 0;
  return res.undetermined ? 2 : 1;
}

function main() {
  const args = process.argv.slice(2);
  const pr = Number(args.find((a) => /^\d+$/.test(a)));
  const warn = flag(args, '--warn');
  try {
    const head = opt(args, '--head');
    if (!pr || !head) throw new Error('usage: land-none-check.mjs <pr> --repo <o/r> --head <sha> [--store f] [--fixture f] [--warn] [--json]');
    const { pull, files, config } = load(args, opt(args, '--repo') ?? DEFAULT_REPO, pr);
    if (pull.head.sha !== head) throw new Error(`--head ${sha7(head)} is not the PR head ${sha7(pull.head.sha)}`);
    changedPaths(files, pull);
    const labels = pullLabelNames(pull);
    const band = bandOf(files, config, { labels })?.band ?? null;
    process.exit(report(nonePick({ pr, head, labels, band, read: makeReader(pr, opt(args, '--store')) }), { pr, warn, json: flag(args, '--json') }));
  } catch (err) {
    const message = String(err.message).split('\n')[0];
    console.log(`${warn ? 'WARNING' : 'land-none-check'}: could not determine (${message})`);
    process.exit(warn ? 0 : 2);
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) main();
