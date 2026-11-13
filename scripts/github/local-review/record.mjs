// The local review engine's records: append-only JSON files, one per run.
// Path: <state root>/<branch-slug>/<head40>/<runId>.json (spec 13.3). A file is written once and never replaced.
// majorsOpen at a head is the union of the open Majors of every run at that head, so a re-run cannot erase an earlier Major.
// The state root is injectable (opts.stateRoot, then env LOCAL_REVIEW_STATE_DIR) so tests use a temp folder.
import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock as fileLock } from '../lib/file-lock.mjs';

export const RECORD_SCHEMA = 2;
/**
 * The contract fields of a schema 2 record, one list for every reader and writer (design note re-engine-cli-schema, section 4). A field that no
 * lane fills yet holds a fixed empty value. A schema 1 record already has promptVersion and none of the others: readers must not require the others.
 */
export const RECORD_FIELDS = Object.freeze([
  'promptVersion', 'contextVersion', 'armId', 'verify', 'uncertainMajors', 'impactRows', 'overallCorrectness',
  'runIds', 'cursorRunId', 'engineMainSha', 'backend', 'target',
]);
const LOCK_WAIT_MS = 5000;
const HEAD40 = /^[0-9a-f]{40}$/;
const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;
const MAJOR = new Set(['critical', 'major']);
const MISSING_CONFIDENCE = 3;
/** A trace file sits beside its record as <runId>.trace.json. It is not a record: listRecords skips it. */
export const TRACE_SUFFIX = '.trace.json';

/** Folder-safe branch name: keep [A-Za-z0-9._-], map the rest to '-'. A name with '..' or no usable text is refused (throws). */
export function branchSlug(branch) {
  const raw = String(branch ?? '');
  if (raw.includes('..')) throw new Error(`branch name "${raw}" holds ".." and is refused`);
  const slug = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  if (slug === '' || /^\.+$/.test(slug)) throw new Error(`branch name "${raw}" gives no usable folder name`);
  return slug;
}

export function stateRoot(opts = {}) {
  const env = opts.env ?? process.env;
  return opts.stateRoot || env.LOCAL_REVIEW_STATE_DIR || path.join(os.homedir(), '.claude', 'state', 'local-review');
}

function checkHead(head) {
  const h = String(head ?? '').toLowerCase();
  if (!HEAD40.test(h)) throw new Error(`head "${head}" is not a 40-character sha`);
  return h;
}

const branchDir = (branch, opts) => path.join(stateRoot(opts), branchSlug(branch));
const headDir = (branch, head, opts) => path.join(branchDir(branch, opts), checkHead(head));

/**
 * The funnel of one run: { raw, withdrawn, dropped: { byReason }, posted }.
 * raw = findings in the answer before the filter; withdrawn = findings the reviewer says it dropped; dropped = what the S5 filter removed, by
 * reason (no-file, no-line, claim-refuted, duplicate; the thread-min rule is not a drop); posted = findings the filter kept in this run
 * (carried-over prior findings are not counted).
 */
export function buildFunnel({ answer, dropped = [], kept = [] }) {
  const byReason = {};
  for (const d of dropped) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
  return { raw: answer?.findings?.length ?? 0, withdrawn: answer?.withdrawn?.length ?? 0, dropped: { byReason }, posted: kept.length };
}

/** The confidence of a finding. A missing or non-numeric value counts as 3, so a finding without one is not silently low. */
export const confidenceOf = (f) => (typeof f?.confidence === 'number' && Number.isFinite(f.confidence) ? f.confidence : MISSING_CONFIDENCE);

/** critical or major, still open, confidence >= 3. A finding with no status counts as open. */
export const isMajorOpen = (f) => MAJOR.has(f?.severity) && (f.status ?? 'open') === 'open' && confidenceOf(f) >= MISSING_CONFIDENCE;

const findingKey = (f) => f.id ?? `${f.file}|${f.startLine ?? f.line}|${f.title}`;

/**
 * The open Majors over a record or a list of records (the runs at one head), one entry per finding id.
 * Returns the findings; the count is `.length`.
 */
export function majorsOpen(input) {
  const records = Array.isArray(input) ? input : [input];
  const seen = new Map();
  for (const rec of records) {
    for (const f of rec?.findings ?? []) {
      if (isMajorOpen(f) && !seen.has(findingKey(f))) seen.set(findingKey(f), f);
    }
  }
  return [...seen.values()];
}

function readJsonFiles(dir, io) {
  const out = { records: [], unreadable: [] };
  let names;
  try { names = io.readdirSync(dir); } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const name of names.filter((n) => n.endsWith('.json') && !n.endsWith(TRACE_SUFFIX)).sort()) {
    const file = path.join(dir, name);
    try { out.records.push({ path: file, record: JSON.parse(io.readFileSync(file, 'utf8')) }); } catch { out.unreadable.push(file); }
  }
  return out;
}

const byTs = (a, b) => String(a.record.ts ?? '').localeCompare(String(b.record.ts ?? '')) || a.path.localeCompare(b.path);

/** { records: [{ path, record }] oldest first, unreadable: [path] } for every run at one head. */
export function listRecords({ branch, head }, opts = {}) {
  const io = { ...nodeFs, ...opts.fs };
  const found = readJsonFiles(headDir(branch, head, opts), io);
  return { ...found, records: found.records.sort(byTs) };
}

const isComplete = (rec) => rec?.status === 'ok' && rec?.coverage?.complete === true;

/** The newest record at a head, or the one named by runId. completeOnly keeps status ok with full coverage. Null when none. */
export function findRecord({ branch, head, runId, completeOnly = false }, opts = {}) {
  const { records } = listRecords({ branch, head }, opts);
  const pool = records.filter((r) => (runId === undefined || r.record.runId === runId) && (!completeOnly || isComplete(r.record)));
  return pool.length ? pool.at(-1).record : null;
}

/**
 * The head of the newest ok and complete record whose head is an ancestor of `head` (or equal to it), or null.
 * isAncestor(candidate, head) is injected (git merge-base --is-ancestor). trustedOnly skips records with trusted:false.
 */
export function lastReviewedSha({ branch, head, isAncestor, trustedOnly = false }, opts = {}) {
  if (typeof isAncestor !== 'function') throw new Error('lastReviewedSha needs an isAncestor function');
  const io = { ...nodeFs, ...opts.fs };
  const dirs = (() => { try { return io.readdirSync(branchDir(branch, opts)).filter((d) => HEAD40.test(d)); } catch { return []; } })();
  const all = dirs.flatMap((h) => listRecords({ branch, head: h }, opts).records);
  const ok = all.filter((r) => isComplete(r.record) && (!trustedOnly || r.record.trusted === true));
  const hit = ok.sort(byTs).reverse().find((r) => HEAD40.test(String(r.record.head)) && isAncestor(r.record.head, checkHead(head)));
  return hit ? hit.record.head : null;
}

/**
 * Applies a run's `prior` answers to the findings of the earlier head. Pure.
 * - a file that is gone gives status 'stale';
 * - a finding closes ('fixed') only when the model answered exactly "fixed" AND touches(finding) says the delta changed its lines;
 * - no answer, any other answer, or untouched lines: the finding stays as it was (open stays open).
 */
export function settlePrior(prior, answers, { touches, exists = () => true } = {}) {
  if (typeof touches !== 'function') throw new Error('settlePrior needs a touches function');
  return (prior ?? []).map((f) => {
    if ((f.status ?? 'open') !== 'open') return { ...f };
    if (!exists(f.file)) return { ...f, status: 'stale' };
    const closed = answers?.[f.id] === 'fixed' && touches(f);
    return { ...f, status: closed ? 'fixed' : 'open' };
  });
}

/**
 * Writes one record, once. The body goes to a temp file in the same folder and is then renamed into place, so a reader never sees a
 * part-written record. An existing record at the path is never replaced (throws). The stored majorsOpen is the union over every
 * run already at this head plus this one. The listing, the union and the rename run under the head-folder lock, so two writers at
 * one head cannot both miss the other's Major; a lock that stays held throws. opts.withLock and opts.lockWaitMs are for tests.
 * Returns { path, sha256, record }; sha256 is of the stored bytes (the ledger recordSha256).
 */
export function writeRecord(record, opts = {}) {
  const io = { ...nodeFs, ...opts.fs };
  const runId = String(record?.runId ?? '');
  if (!RUN_ID.test(runId) || runId.includes('..')) throw new Error(`runId "${runId}" is not usable as a file name`);
  const dir = headDir(record.branch, record.head, opts);
  io.mkdirSync(dir, { recursive: true });
  const locked = (opts.withLock ?? fileLock)(path.join(dir, 'records'), { lockWaitMs: opts.lockWaitMs ?? LOCK_WAIT_MS }, () => writeLocked(record, { dir, runId, io }, opts));
  if (locked?.ok === false) throw new Error(`record lock at ${dir} is not free: ${locked.detail ?? locked.reason ?? 'held'}`);
  return locked;
}

/** The part of writeRecord that needs the lock: the exists check, the listing of earlier runs, the union and the rename. */
function writeLocked(record, { dir, runId, io }, opts) {
  const final = path.join(dir, `${runId}.json`);
  if (io.existsSync(final)) throw new Error(`record ${final} exists: records are append-only`);
  const earlier = listRecords({ branch: record.branch, head: record.head }, opts);
  const problems = [...(record.problems ?? []), ...earlier.unreadable.map((p) => `unreadable record: ${p}`)];
  const ts = record.ts ?? new Date((opts.now ?? Date.now)()).toISOString();
  const stored = { ...record, schema: RECORD_SCHEMA, ts, problems, majorsOpen: majorsOpen([...earlier.records.map((r) => r.record), record]).length };
  const body = `${JSON.stringify(stored, null, 2)}\n`;
  const tmp = path.join(dir, `.${runId}.${process.pid}.tmp`);
  io.writeFileSync(tmp, body);
  try { io.renameSync(tmp, final); } catch (err) { try { io.unlinkSync(tmp); } catch { /* already gone */ } throw err; }
  return { path: final, sha256: createHash('sha256').update(body).digest('hex'), record: stored };
}
