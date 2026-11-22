#!/usr/bin/env node
/**
 * land-none-check.mjs - the land gate for a review:none PR at band HIGH or CRITICAL (lane agent-self-approve-hole, Dave 2026-11-03: DETECT).
 *
 * Anyone with write access can add the review:none label (or swap the labels to a lone risk:docs), and the pr-checkpoint engine takes `--by dave`
 * at every band. So the labels and the router state alone do not show that Dave chose "no review". The pr-checkpoint mod stores how he chose
 * (`via`) in its plugin store. This check reads that record before land-pr.ps1 merges. It passes only for Dave's own pick (dialog or composer) on this exact head, at a band that did
 * not rise since. It prints one provenance line, so Dave sees who chose what before he says land.
 *
 * Usage: node scripts/github/land-none-check.mjs <pr> --repo <o/r> --head <sha> [--store <file>] [--fixture <file>] [--remote <name>] [--warn] [--json]
 *   --remote   the git remote of the base branch (default fork). The check fetches <remote>/<base> and refuses when the band code of this checkout differs from it.
 *              A --fixture run does the base-code check only when --remote is given (tests).
 *   --store    one store file instead of ~/.claude/plugins/store/ccv3-mods_*.json (tests).
 *   --fixture  { pull, files, config }: no gh call (tests and the probe).
 *   --warn     print the same text but always exit 0 (land-pr.ps1 -IgnoreReview: Dave's own yes, made informed).
 * Exit: 0 = ok or not needed, 1 = refused, 2 = could not determine.
 * The files and labels come from the live PR; the band config comes from the base ref through the contents API, never the local checkout.
 * The band CODE (bandOf and the files it imports) is the code of the checkout that runs this script. baseCodeProblem() refuses when that code differs
 * from the base branch tip after a fresh fetch (card force-high-land-path, aegis on PR 669): a PR must not lower its own bar by editing bandOf and then
 * being landed from its own worktree. Known limit: this script and land-pr.ps1 are themselves the checkout's copy; both are on FORCE_HIGH_FILES, so an
 * edit to either needs Dave's recorded pick.
 * Not covered, accepted: an agent that writes a forged record from a script that builds the path in code. Docs: pr-review-loop.md, land section.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandOf, changedPaths, DEFAULT_REPO, loadLive, makeGh } from './review-router.mjs';
import { pullLabelNames, requiredBots } from './review-status.mjs';

/**
 * The files this check runs: its own static import closure, as repo paths. land-none-base-code.test.mjs walks the imports and fails when this list and
 * the closure differ, so a new import cannot slip past the base-code check.
 */
export const BAND_CODE_FILES = Object.freeze([
  'scripts/github/land-none-check.mjs', 'scripts/github/review-router.mjs', 'scripts/github/review-status.mjs',
  'scripts/github/lib/answer-key.mjs', 'scripts/github/lib/answer-paths.mjs', 'scripts/ratchets/lib/review-md.mjs',
]);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * git for the base-code check runs no hook (aegis F1 on PR 673): the fetch updates a ref, and git then runs the reference-transaction hook of core.hooksPath, which a PR
 * can add (.githooks is not a forced file). core.hooksPath=/dev/null names no folder: git resolves it to the null device (nul on Windows), where no hook file can exist.
 * A temp folder is no answer: on this machine %TEMP% grants Modify to the Codex sandbox accounts, so a hook could be planted there (aegis, round 2).
 */
export const HOOKS_OFF_ARGS = Object.freeze(['-c', 'core.hooksPath=/dev/null']);
const defaultGit = (root) => (args) => spawnSync('git', ['-C', root, ...HOOKS_OFF_ARGS, ...args], { encoding: 'utf8', windowsHide: true });
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'no message';
const SAFE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Why the band code of the checkout may not decide the band, or null. Fetches <remote>/<baseRef> fresh (a failed fetch is a problem: the base code cannot be read),
 * then compares each file of `files` as the process runs it (git hash-object --path=<repo path> <file>, so CRLF and other filters give the blob hash) with the
 * same path at the fetched tip. A file that differs, or that the checkout or the tip lacks, is named. `git` is injectable for tests.
 */
export function baseCodeProblem({ root = REPO_ROOT, baseRef, remote = 'fork', files = BAND_CODE_FILES, git = defaultGit(root) } = {}) {
  const ref = String(baseRef ?? '');
  if (!SAFE_NAME.test(ref) || !SAFE_NAME.test(String(remote))) return `could not fetch ${remote}/${ref || '(no base branch)'}: the name is not a plain git name`;
  const fetched = git(['fetch', '--quiet', remote, `+refs/heads/${ref}:refs/remotes/${remote}/${ref}`]);
  if (fetched.status !== 0) return `could not fetch ${remote}/${ref} (${firstLine(fetched.stderr)}): the base code cannot be read, so the band code of this checkout cannot be checked`;
  const tip = String(git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${ref}^{commit}`]).stdout ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(tip)) return `could not fetch ${remote}/${ref}: the fetched branch tip is not readable`;
  const differs = files.filter((rel) => {
    const abs = path.join(root, rel);
    const base = String(git(['rev-parse', '--verify', '--quiet', `${tip}:${rel}`]).stdout ?? '').trim();
    if (!existsSync(abs) || !/^[0-9a-f]{40}$/.test(base)) return true;
    return String(git(['hash-object', `--path=${rel}`, abs]).stdout ?? '').trim() !== base;
  });
  if (differs.length === 0) return null;
  return `the band code of this checkout differs from ${remote}/${ref} at ${tip.slice(0, 7)}: ${differs.join(', ')}. The none-pick check would run that code, so a PR could lower its own band. Run the land from a checkout of ${ref} that holds ${remote}/${ref} (git fetch ${remote}, git switch ${ref}, git pull --ff-only).`;
}

const RANK = { LOW: 0, MID: 1, ELEVATED: 2, HIGH: 3, CRITICAL: 4 };
const NEEDS_RECORD = new Set(['HIGH', 'CRITICAL']);
const PICKED_BY_DAVE = new Set(['dialog', 'composer']);
const rankOf = (band) => RANK[band] ?? -1;
const sha7 = (sha) => String(sha ?? '').slice(0, 7).toLowerCase() || 'none';
/** Two shas are the same commit when they match in lower case: a hand-typed upper-case sha must not refuse a good record. */
const sameSha = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

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
  if (!sameSha(v.head, head)) return `the record is for head ${sha7(v.head)}, the PR head is ${sha7(head)}; a push after the pick makes it stale`;
  if (rankOf(v.band) < 0) return 'the record has no band';
  if (rankOf(band) > rankOf(v.band)) return `the band is ${band} now and was ${v.band} at the pick`;
  if (localTime(v.at) === null) return `the record's at is not a date (${JSON.stringify(v.at)})`;
  return null;
}

const skip = (reason) => ({ needed: false, ok: true, line: null, problem: null, reason });
const refuse = (problem, undetermined = false, lead = 'review:none pick is not on record') => ({ needed: true, ok: false, undetermined, line: null, problem, lead });

/** Problems from the store files that could not be read: named, so Dave knows which file broke. */
const storeProblems = (found) => [
  ...(found.files.length === 0 ? [`no plugin store file found (looked for ${found.glob})`] : []),
  ...found.bad.map((b) => `store file ${b.file} is not valid JSON (${b.error})`),
];

/** READY's own reading of the labels: true when neither Greptile nor CodeRabbit is asked to review (review:none, or a lone risk:docs). */
function asksNoBot(labels) {
  const need = requiredBots(labels);
  return !need.greptile && !need.coderabbit;
}

/**
 * nonePick({ pr, head, labels, band, read }) -> { needed, ok, line, problem, undetermined?, reason? }
 *   band: the live band name (bandOf(...)?.band) or null. head: the PR head sha.
 *   read: () => { glob, files, records: [{ file, value }], bad: [{ file, error }] }. Called only when a record is needed.
 * Not needed: the labels ask for a bot review (requiredBots), or band LOW, MID or ELEVATED. "No bot" is review:none, or a lone risk:docs.
 * A null band with a no-bot label set is undetermined (fail closed).
 */
export function nonePick({ pr, head, labels = [], band = null, read }) {
  if (!asksNoBot(labels)) return skip('the labels ask for a bot review');
  if (band === null || band === undefined || rankOf(band) < 0) return refuse('the review band could not be computed from the base config, so the none pick cannot be checked', true);
  if (!NEEDS_RECORD.has(band)) return skip(`band ${band} needs no record`);
  const found = read();
  // One record, one file. Two files that hold a record for the PR are ambiguous (a stale one, or a forged one): refuse and name both.
  const held = found.records.filter((r) => r.value !== undefined);
  if (held.length > 1) return refuse(`more than one store file holds checkpoint:pr:${pr} (${held.map((r) => r.file).join(', ')}); keep one`);
  const checked = found.records.map((r) => ({ ...r, problem: recordProblem(r.value, { pr, head, band }) }));
  const good = checked.find((r) => r.problem === null);
  if (good) return { needed: true, ok: true, problem: null, line: `Dave chose none at ${localTime(good.value.at)} via ${good.value.via}, head ${sha7(head)} (band ${band}, store ${good.file}${brokenNote(found)})` };
  const problems = [...storeProblems(found), ...checked.map((r) => `${r.file}: ${r.problem}`)];
  return refuse(problems.join('; '));
}

/** A store file that could not be read, next to a good record, goes on the provenance line: Dave sees it. */
const brokenNote = (found) => (found.bad.length ? `; ignored: ${found.bad.map((b) => `${b.file} is not valid JSON`).join(', ')}` : '');

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
export function makeReader(pr, storeArg, dir = defaultStoreDir()) {
  return () => {
    const { glob, files } = storeFiles(storeArg, dir);
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
/** A live run always checks the band code against the base; a fixture run (tests) checks only when --remote is given. */
export const baseCheckWanted = (args) => !opt(args, '--fixture') || Boolean(opt(args, '--remote'));

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
  else console.log(`${warn ? 'WARNING' : 'REFUSED'}: PR #${pr} ${res.lead ?? 'review:none pick is not on record'}: ${res.problem}`);
  if (res.ok || warn) return 0;
  return res.undetermined ? 2 : 1;
}

function main() {
  const args = process.argv.slice(2);
  const pr = Number(args.find((a) => /^\d+$/.test(a)));
  const warn = flag(args, '--warn');
  try {
    let head = opt(args, '--head');
    if (!pr || !head) throw new Error('usage: land-none-check.mjs <pr> --repo <o/r> --head <sha> [--store f] [--fixture f] [--warn] [--json]');
    const { pull, files, config } = load(args, opt(args, '--repo') ?? DEFAULT_REPO, pr);
    if (!sameSha(pull.head.sha, head)) throw new Error(`--head ${sha7(head)} is not the PR head ${sha7(pull.head.sha)}`);
    changedPaths(files, pull);
    // The band code must be the base branch's code. Live runs always check; a fixture run (tests) checks only when --remote is given.
    const remote = opt(args, '--remote');
    if (baseCheckWanted(args)) {
      const problem = baseCodeProblem({ baseRef: pull.base?.ref, remote: remote ?? 'fork' });
      if (problem) process.exit(report(refuse(problem, problem.startsWith('could not fetch'), 'band code differs from the base branch'), { pr, warn, json: flag(args, '--json') }));
    }
    const labels = pullLabelNames(pull);
    head = pull.head.sha;
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
