#!/usr/bin/env node
/**
 * pr-spend -- write ~/.claude/state/lane-dash/pr-spend.json: one row per pull request with the review spend the local ledgers
 * can prove. No model, no network, no database. The Fleet PR row (card prflow-pr-row) reads the file later. NOT IN FORCE: no
 * tap and no gate reads it. The file is private (dollars per PR): it stays in lane-dash and is not on the FleetOps upload list.
 * Contract: .claudedocs/e2e-prflow-spend-line/2026-11-12-contract-note.md (design rules 1 to 9, seat ruling Q1 to Q4, P1 to P5).
 *
 *   node scripts/github/pr-spend.mjs [--out <dir>] [--coderabbit <file>] [--cursor <file>] [--land <file>] [--headless <file>]
 *                                    [--primary-root <dir>]
 *
 * Sources (default folder ~/.claude/state, each path has a flag):
 *   coderabbit-paid.jsonl         PR rows {pr, head, files, cost}: dollars. CLI rows {kind:"cli"}: unattributed.
 *   cursor-review-ledger.jsonl    END rows only, joined to their START row by id: tokens, never dollars (no price table exists).
 *   land-outcomes.jsonl           one row per land: mergeSha, mergeCall, reviewers, crRounds.
 *   headless-review-ledger.jsonl  no PR link: unattributed, dollars are nominal under the subscription and in no total.
 * The local-review engine records (local-review/<slug>/<head>/*.json) are never read: they repeat the ledger `usage`.
 *
 * Rules (each one is pinned by a test in pr-spend.test.mjs):
 *   1. Join on pr only. Spend sums across heads. A head is never written; the row has a count of heads.
 *   2. Repo proof. A row that names another repo is skipped. The CCv3 repo is "Rev4nchist/Continuous-Claude-v3" ("continuous-claude"
 *      is the same repo). A CodeRabbit PR row (it has no repo field) or a cursor row with no repo counts only when its head resolves
 *      in the CCv3 object store of the checkout this script is in (the primary checkout in the nightly run; a linked worktree
 *      shares that store; --primary-root overrides it). One `git cat-file --batch-check` process serves all heads (10 s limit,
 *      hidden window). A head that is not 7 to 40 hex, a "missing" or "ambiguous" answer, a time-out or a git failure leaves
 *      the row in notProven. The file is written in every case.
 *   3. Cursor rule (P1, seat ruling). A cursor END row counts for a PR only when ALL hold:
 *        - it has a pr (a positive whole number);
 *        - its ref (end row, else the start row of the same id) starts with "branch-". This is an allowlist: eval-, trex-,
 *          range-, plan-, linktype- and every other ref are out. If the start and end rows disagree (two different branch refs
 *          too), the row is out. A run is another repo when either row names another repo;
 *        - its purpose (end row, else start row) is absent or "review" (verify, bench and the rest are out).
 *      Today's measured end-row combos: pr + purpose review + ref branch- (46), pr + no purpose + ref branch- (30), pr + mode delta +
 *      ref branch- (1). The cursor rows hold no kind or label field; mode (full, delta) is a review run either way.
 *      Spend is tokens {in, out, cacheRead, cacheWrite} (a null usage adds none), the run count and the timed-out count.
 *   4. CodeRabbit PR rows: usd = sum of cost, rounds = row count, files = sum. NEVER deduplicated: rows have no id, and two
 *      real rounds on one head look the same. CLI rows (kind "cli", no pr) go to unattributed.coderabbitCli {rows, usd}.
 *   5. Headless rows go to unattributed.headless {runs, nominalUsd, note}. Rows show headless and sessionTokens as "not shown".
 *   6. Land ledger: per PR {mergeSha, mergeCall, reviewers, crRounds} (mergeSha is null for "merged-elsewhere"), else null; the
 *      last row of a PR wins. LAND LEDGER READ (seat P2): a plain readFileSync. Node opens a file on Windows with shared read, write
 *      and delete access, so a land that appends to the ledger is never blocked. This script never opens it for write and takes
 *      no lock on it.
 *   7. Each ledger has its own line reader. A bad line (not JSON, or not an object) is skipped and counted; a BOM and a trailing
 *      CR are stripped. A missing or unreadable ledger is state "absent" and its part shows null, never 0. A ledger that is
 *      present but has no row for a PR shows zeros for that PR.
 *   8. The file holds no session id, branch, ref, path, head or finding text. Every output object is built from named fields;
 *      a ledger row is never spread into the output. The row key is "<repo>#<pr>". Rows sort by pr, highest first.
 *   9. The nightly run means spend up to a day old: the file carries exportedAt so a reader can show the age.
 *
 * Writes <out>/pr-spend.json through a temp file and a rename, under <out>/.pr-spend.lock (same as export-factory-data.mjs).
 * Exit 0 and one summary line (counts and dollars) when the file is written; exit 1 and one line when it cannot be; exit 2 for a
 * bad argument. Importing this file does nothing: no I/O.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The default folder for the head lookup is the checkout this script sits in (two levels up). The nightly run starts from the primary
// checkout, and a linked worktree shares its object store, so either proves a head. No second git call looks the primary up.
const CHECKOUT_ROOT = path.resolve(HERE, '..', '..');
const CCV3_REPO = 'Rev4nchist/Continuous-Claude-v3';
const CCV3_NAMES = new Set([CCV3_REPO.toLowerCase(), 'continuous-claude']);
const GIT_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const HEAD_SHAPE = /^[0-9a-f]{7,40}$/i;
const HEADLESS_NOTE = 'nominal under the subscription, not billed, in no dollar total';
const GIT_ENV_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

// ---------------------------------------------------------------- small helpers

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPr = (v) => Number.isInteger(v) && v > 0;
const cents = (n) => Math.round(n * 100) / 100;
const tokenOf = (v) => (isNum(v) && v > 0 ? v : 0);

/** 'ccv3', 'other' (names another repo) or 'unknown' (no repo field, null or empty). */
export function repoVerdict(repo) {
  if (repo === undefined || repo === null || repo === '') return 'unknown';
  return typeof repo === 'string' && CCV3_NAMES.has(repo.trim().toLowerCase()) ? 'ccv3' : 'other';
}

// ---------------------------------------------------------------- reading

/** The objects of a JSONL text. A bad line (not JSON, or JSON that is not an object) is skipped and counted. */
export function parseJsonl(text) {
  const rows = [];
  let skipped = 0;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (isObject(o)) rows.push(o); else skipped++;
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

/** One ledger: {state:"ok"|"absent", objs, skipped}. A missing or unreadable file is "absent". Never throws. */
export function readLedger(file, read = readFileSync) {
  let text;
  try {
    text = read(file, 'utf8');
  } catch {
    return { state: 'absent', objs: [], skipped: 0 };
  }
  const { rows, skipped } = parseJsonl(text);
  return { state: 'ok', objs: rows, skipped };
}

// ---------------------------------------------------------------- git: repo proof

/** The one git process: `git cat-file --batch-check`, one `<head>^{commit}` line per head. Returns the spawnSync result. */
export function gitBatchCheck(heads, cwd) {
  const env = { ...process.env };
  for (const k of GIT_ENV_DROP) delete env[k];
  return spawnSync('git', ['cat-file', '--batch-check'], {
    cwd, env, input: heads.map((h) => `${h}^{commit}\n`).join(''), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true,
  });
}

/**
 * Which heads resolve to a commit in the repo at `cwd`. Returns {ok, proven:Set<lowercase head as sent>}.
 * ok is false on a spawn error, a time-out, a nonzero status or an answer count that differs from the heads sent.
 * Only heads of 7 to 40 hex characters are sent (a name such as HEAD would resolve in any repo).
 */
export function proveHeads(heads, cwd, run = gitBatchCheck) {
  const sendable = [...new Set(heads.filter((h) => typeof h === 'string' && HEAD_SHAPE.test(h)).map((h) => h.toLowerCase()))];
  const proven = new Set();
  if (sendable.length === 0) return { ok: true, proven, ran: false };
  let r;
  try { r = run(sendable, typeof cwd === 'function' ? cwd() : cwd); } catch { return { ok: false, proven, ran: true }; }
  const answers = String(r?.stdout ?? '').split('\n').filter((l) => l.length > 0);
  if (!r || r.error || r.status !== 0 || answers.length !== sendable.length) return { ok: false, proven, ran: true };
  answers.forEach((line, i) => {
    const m = /^([0-9a-f]{40}) commit \d+$/.exec(line.trim());
    if (m && m[1].startsWith(sendable[i])) proven.add(sendable[i]);
  });
  return { ok: true, proven, ran: true };
}

// ---------------------------------------------------------------- collecting rows from each ledger

/** CodeRabbit rows: PR rows to prRows, CLI rows to a sum, anything else (no pr, bad cost) counted in bad. */
export function collectCoderabbit(objs) {
  const prRows = [];
  const cli = { rows: 0, usd: 0 };
  let bad = 0;
  for (const o of objs) {
    if (!isNum(o.cost) || o.cost < 0) { bad++; continue; }
    if (o.kind === 'cli' && o.pr === undefined) { cli.rows++; cli.usd += o.cost; continue; }
    if (!isPr(o.pr)) { bad++; continue; }
    prRows.push({ pr: o.pr, head: o.head, repo: o.repo, usd: o.cost, files: isNum(o.files) && o.files > 0 ? o.files : 0 });
  }
  return { prRows, cli, bad };
}

const refOf = (start, end) => ({ refs: [end?.ref, start?.ref].filter((v) => v !== undefined && v !== null), purposes: [end?.purpose, start?.purpose].filter((v) => v !== undefined && v !== null) });

/** Rule 3 (P1): is this END row, with its START row, a review run on a branch? Fail closed when the two rows disagree. */
export function isBranchReview(start, end) {
  const { refs, purposes } = refOf(start, end);
  if (refs.length === 0 || !refs.every((r) => typeof r === 'string' && r.startsWith('branch-'))) return false;
  if (new Set(refs).size > 1) return false; // two different branch refs: the rows disagree
  return purposes.every((p) => p === 'review');
}

/** The repo of a run: a repo that is not CCv3 on either row wins, so an end row cannot hide another repo on its start row. */
export function repoOfRun(start, end) {
  const named = [end?.repo, start?.repo].filter((v) => v !== undefined && v !== null);
  return named.find((r) => repoVerdict(r) !== 'ccv3') ?? named[0];
}

/** Cursor END rows with a pr, split by rule 3. Start rows are indexed by id and used only for ref, purpose and repo. */
export function collectEngine(objs) {
  const starts = new Map();
  for (const o of objs) if (o.phase === 'start' && typeof o.id === 'string') starts.set(o.id, o);
  const runs = [];
  let prEndRows = 0;
  let notReview = 0;
  let bad = 0;
  for (const o of objs) {
    if (o.phase !== 'end' || o.pr === undefined || o.pr === null) continue;
    prEndRows++;
    if (!isPr(o.pr)) { bad++; continue; }
    const start = starts.get(o.id);
    if (!isBranchReview(start, o)) { notReview++; continue; }
    const u = isObject(o.usage) ? o.usage : {};
    runs.push({
      pr: o.pr, head: o.head, repo: repoOfRun(start, o), timedOut: o.timedOut === true,
      tokens: { in: tokenOf(u.inputTokens), out: tokenOf(u.outputTokens), cacheRead: tokenOf(u.cacheReadTokens), cacheWrite: tokenOf(u.cacheWriteTokens) },
    });
  }
  return { runs, prEndRows, notReview, bad };
}

/** Land rows: the last row of each PR wins. A row with no CCv3 repo name is excluded (counted). */
export function collectLand(objs) {
  const byPr = new Map();
  let otherRepo = 0;
  let bad = 0;
  for (const o of objs) {
    if (!isPr(o.pr)) { bad++; continue; }
    if (repoVerdict(o.repo) !== 'ccv3') { otherRepo++; continue; }
    byPr.set(o.pr, {
      mergeSha: typeof o.mergeSha === 'string' && /^[0-9a-f]{7,40}$/i.test(o.mergeSha) ? o.mergeSha : null,
      mergeCall: typeof o.mergeCall === 'string' ? o.mergeCall.slice(0, 40) : null,
      reviewers: Array.isArray(o.reviewers) ? o.reviewers.filter((x) => typeof x === 'string').map((x) => x.slice(0, 24)).slice(0, 6) : [],
      crRounds: Number.isInteger(o.crRounds) && o.crRounds >= 0 ? o.crRounds : 0,
    });
  }
  return { byPr, otherRepo, bad };
}

/** Headless rows: the end rows with their nominal dollars. No row is tied to a PR. */
export function collectHeadless(objs) {
  let runs = 0;
  let usd = 0;
  for (const o of objs) {
    if (o.phase !== 'end') continue;
    runs++;
    if (isNum(o.costUsd) && o.costUsd > 0) usd += o.costUsd;
  }
  return { runs, usd };
}

// ---------------------------------------------------------------- repo proof: split items into counted, other repo, not proven

/** Rule 2. Items with repo "ccv3" count; "other" is skipped; "unknown" counts only when its head is proven. */
export function splitByRepo(items, proof) {
  const counted = [];
  const notProven = [];
  let otherRepo = 0;
  for (const it of items) {
    const v = repoVerdict(it.repo);
    if (v === 'other') otherRepo++;
    else if (v === 'ccv3') counted.push(it);
    else if (typeof it.head === 'string' && proof.proven.has(it.head.toLowerCase())) counted.push(it);
    else notProven.push(it);
  }
  return { counted, notProven, otherRepo };
}

const unknownHeads = (items) => items.filter((it) => repoVerdict(it.repo) === 'unknown').map((it) => it.head);

// ---------------------------------------------------------------- the rows

const zeroTokens = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });

/** Rule 1 and 8. One row per PR, joined on pr alone, every field named. A null part means that ledger is absent. */
export function buildRows({ coderabbit, engine, land, present }) {
  const prs = new Map();
  const slot = (pr) => {
    if (!prs.has(pr)) prs.set(pr, { heads: new Set(), cr: { usd: 0, rounds: 0, files: 0 }, eng: { runs: 0, timedOut: 0, tokens: zeroTokens() } });
    return prs.get(pr);
  };
  for (const c of coderabbit) {
    const s = slot(c.pr);
    s.cr.usd += c.usd; s.cr.rounds += 1; s.cr.files += c.files;
    if (typeof c.head === 'string') s.heads.add(c.head.toLowerCase());
  }
  for (const e of engine) {
    const s = slot(e.pr);
    s.eng.runs += 1; if (e.timedOut) s.eng.timedOut += 1;
    for (const k of Object.keys(s.eng.tokens)) s.eng.tokens[k] += e.tokens[k];
    if (typeof e.head === 'string') s.heads.add(e.head.toLowerCase());
  }
  for (const pr of land.keys()) slot(pr);
  return [...prs.keys()].sort((a, b) => b - a).map((pr) => {
    const s = prs.get(pr);
    return {
      key: `${CCV3_REPO}#${pr}`,
      repo: CCV3_REPO,
      pr,
      heads: s.heads.size,
      coderabbit: present.coderabbit ? { usd: cents(s.cr.usd), rounds: s.cr.rounds, files: s.cr.files } : null,
      engine: present.cursor ? { runs: s.eng.runs, timedOut: s.eng.timedOut, tokens: { ...s.eng.tokens } } : null,
      landed: land.get(pr) ?? null,
      headless: 'not shown',
      sessionTokens: 'not shown',
    };
  });
}

const sumUsd = (items) => cents(items.reduce((n, it) => n + it.usd, 0));
const sumFiles = (items) => items.reduce((n, it) => n + it.files, 0);

/** The whole document from the four ledgers. `deps` = {now, primaryRoot, runGit}. Pure apart from the one git process. */
export function buildDocument(ledgers, deps) {
  const cr = collectCoderabbit(ledgers.coderabbit.objs);
  const eng = collectEngine(ledgers.cursor.objs);
  const land = collectLand(ledgers.land.objs);
  const hl = collectHeadless(ledgers.headless.objs);
  const proof = proveHeads([...unknownHeads(cr.prRows), ...unknownHeads(eng.runs)], deps.primaryRoot, deps.runGit);
  const crSplit = splitByRepo(cr.prRows, proof);
  const engSplit = splitByRepo(eng.runs, proof);
  const present = { coderabbit: ledgers.coderabbit.state === 'ok', cursor: ledgers.cursor.state === 'ok' };
  const src = (name, extraBad) => ({ state: ledgers[name].state, rows: ledgers[name].objs.length, skipped: ledgers[name].skipped + extraBad });
  const absent = (name, v) => (ledgers[name].state === 'ok' ? v : null);
  return {
    schema: 1,
    exportedAt: deps.now().toISOString(),
    sources: { coderabbit: src('coderabbit', cr.bad), cursor: src('cursor', eng.bad), land: src('land', land.bad), headless: src('headless', 0) },
    rows: buildRows({ coderabbit: crSplit.counted, engine: engSplit.counted, land: land.byPr, present }),
    unattributed: {
      coderabbitCli: absent('coderabbit', { rows: cr.cli.rows, usd: cents(cr.cli.usd) }),
      headless: absent('headless', { runs: hl.runs, nominalUsd: cents(hl.usd), note: HEADLESS_NOTE }),
    },
    notProven: {
      git: proof.ok ? 'ok' : 'failed',
      coderabbit: absent('coderabbit', { rows: crSplit.notProven.length, usd: sumUsd(crSplit.notProven), files: sumFiles(crSplit.notProven) }),
      engine: absent('cursor', { rows: engSplit.notProven.length }),
    },
    excluded: { engineNotReview: eng.notReview, engineOtherRepo: engSplit.otherRepo, coderabbitOtherRepo: crSplit.otherRepo, landOtherRepo: land.otherRepo },
    reconcile: {
      coderabbit: { prRows: cr.prRows.length, counted: crSplit.counted.length, notProven: crSplit.notProven.length, otherRepo: crSplit.otherRepo },
      engine: { prEndRows: eng.prEndRows, counted: engSplit.counted.length, notProven: engSplit.notProven.length, notReview: eng.notReview, otherRepo: engSplit.otherRepo, bad: eng.bad },
    },
  };
}

// ---------------------------------------------------------------- writing

function acquireLock(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS) throw new Error(`pr-spend lock is held: ${lock} (another run is writing; delete the file if it is older than 10 minutes)`);
      try { unlinkSync(lock); } catch { /* another process took it; the retry reports it */ }
    }
  }
  throw new Error(`pr-spend lock is held: ${lock}`);
}

/** Write <outDir>/pr-spend.json through a temp file renamed into place under .pr-spend.lock. Throws when it cannot. */
export function writeDocument(outDir, doc, rename = renameSync) {
  const text = JSON.stringify(doc);
  mkdirSync(outDir, { recursive: true });
  const lock = path.join(outDir, '.pr-spend.lock');
  acquireLock(lock);
  const tmp = path.join(outDir, 'pr-spend.json.tmp');
  try {
    writeFileSync(tmp, text);
    rename(tmp, path.join(outDir, 'pr-spend.json'));
    return { bytes: Buffer.byteLength(text) };
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or never written */ }
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------- command line

const USAGE = `usage: pr-spend.mjs [--out <dir>] [--coderabbit <file>] [--cursor <file>] [--land <file>] [--headless <file>] [--primary-root <dir>]
  --out           output folder (default ~/.claude/state/lane-dash)
  --coderabbit    CodeRabbit paid ledger (default ~/.claude/state/coderabbit-paid.jsonl)
  --cursor        cursor review ledger (default ~/.claude/state/cursor-review-ledger.jsonl)
  --land          land outcomes ledger (default ~/.claude/state/land-outcomes.jsonl)
  --headless      headless review ledger (default ~/.claude/state/headless-review-ledger.jsonl)
  --primary-root  checkout whose object store proves a head (default: the checkout this script is in)`;
const FLAGS = { '--out': 'out', '--coderabbit': 'coderabbit', '--cursor': 'cursor', '--land': 'land', '--headless': 'headless', '--primary-root': 'primaryRoot' };

export function defaultPaths(home = homedir()) {
  const state = path.join(home, '.claude', 'state');
  return {
    out: path.join(state, 'lane-dash'),
    coderabbit: path.join(state, 'coderabbit-paid.jsonl'),
    cursor: path.join(state, 'cursor-review-ledger.jsonl'),
    land: path.join(state, 'land-outcomes.jsonl'),
    headless: path.join(state, 'headless-review-ledger.jsonl'),
  };
}

function parseArgs(argv) {
  const opts = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (!Object.hasOwn(FLAGS, a)) throw new Error(`unknown argument ${a}\n${USAGE}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n${USAGE}`);
    opts[FLAGS[a]] = v;
  }
  return opts;
}

/** One counts-and-dollars line. Headless dollars are never in it. */
export function summaryLine(doc) {
  const money = (n) => `$${cents(n).toFixed(2)}`;
  const cr = doc.sources.coderabbit.state === 'ok'
    ? `coderabbit ${money(doc.rows.reduce((n, r) => n + (r.coderabbit?.usd ?? 0), 0))} (${doc.rows.reduce((n, r) => n + (r.coderabbit?.rounds ?? 0), 0)} rounds)`
    : 'coderabbit absent';
  const eng = doc.sources.cursor.state === 'ok' ? `engine ${doc.rows.reduce((n, r) => n + (r.engine?.runs ?? 0), 0)} runs` : 'engine absent';
  const np = doc.notProven;
  const unproven = `not proven ${np.coderabbit ? `${np.coderabbit.rows} coderabbit rows ${money(np.coderabbit.usd)}` : 'coderabbit absent'} and ${np.engine ? `${np.engine.rows} engine runs` : 'engine absent'} (git ${np.git})`;
  const cli = doc.unattributed.coderabbitCli;
  const hl = doc.unattributed.headless;
  return `pr-spend: ${doc.rows.length} PRs, ${cr}, ${eng}, ${unproven}, cli ${cli ? `${cli.rows} rows ${money(cli.usd)}` : 'absent'}, `
    + `headless ${hl ? `${hl.runs} runs (nominal, not in totals)` : 'absent'}`;
}

/** Run. Returns the exit code. `deps` = {now, home, primaryRoot (a folder), runGit, log, err} (tests inject them). */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const err = deps.err ?? console.error;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`pr-spend: ${e.message}`);
    return 2;
  }
  if (opts.help) { log(USAGE); return 0; }
  const d = defaultPaths(deps.home);
  const file = (k) => path.resolve(opts[k] ?? d[k]);
  const ledgers = Object.fromEntries(['coderabbit', 'cursor', 'land', 'headless'].map((k) => [k, readLedger(file(k))]));
  const root = opts.primaryRoot ?? deps.primaryRoot;
  const doc = buildDocument(ledgers, {
    now: deps.now ?? (() => new Date()),
    primaryRoot: () => root ?? CHECKOUT_ROOT,
    runGit: deps.runGit ?? gitBatchCheck,
  });
  try {
    writeDocument(file('out'), doc, deps.rename);
  } catch (e) {
    err(`pr-spend: ${e.message}`);
    return 1;
  }
  log(summaryLine(doc));
  return 0;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`pr-spend: ${e.message}`);
    process.exit(1);
  });
}
