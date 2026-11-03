// Step A judge pre-check (decision doc 2026-11-02, sections 3.1-3.3): does our judge agree with human labels on Code Review Bench task 1?
// - sameIssue only. The rows have no path, line or hunk, so the hunk is empty and `real` is reported as not measured.
// - Reuses judgePair from judge.mjs and runClaude from scripts/lib/headless.mjs (key strip, shared 30/day Chicago cap).
// - Headless session id is "review-external", purpose "external-judge". It never consumes the P0 eval budget (session "review-eval").
// - Own ledger .claude/cache/hf-datasets/external-judge-ledger.jsonl: at most --daily-share (default 10) judge calls per Chicago day.
// - Resumable: a pair with a judged end row in the ledger is skipped, on this day or a later one.
// - --dry-run reads rows and the ledger, prints the plan and prompts, makes 0 headless calls and writes nothing.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chicagoDay, runClaude } from '../../lib/headless.mjs';
import { judgePair, judgePrompt } from './judge.mjs';
import { assertPinned, datasetDirName, DEFAULT_ROOT, PullRefusal } from './external-pull.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_LEDGER = path.join(DEFAULT_ROOT, 'external-judge-ledger.jsonl');
export const DEFAULT_OUT_DIR = path.join(REPO, '.claude', 'cache', 'e2e');
export const SESSION_ID = 'review-external';
export const DEFAULT_SEED = 20261102;
export const DEFAULT_DATASET = { id: 'code-review-bench/code-review-bench', sha: '343ecc5b815904aea4a1063a898f2325b76f97d0', file: 'human_annotations_task1.parquet' };

// ---- rows -> pairs -------------------------------------------------------------------------------------------------

const parseMaybe = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
const present = (v) => v !== null && v !== undefined && String(v).trim() !== '' && !['nan', 'none', 'null'].includes(String(v).trim().toLowerCase());

/** A finding {title, body, severity} from a string or an object of unknown field names. */
export function toFinding(x) {
  const v = parseMaybe(x);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const body = v.body ?? v.comment ?? v.suggestion ?? v.description ?? v.text ?? v.content;
    return { title: text(v.title ?? v.summary ?? v.type ?? ''), body: body === undefined ? JSON.stringify(v) : text(body), severity: text(v.severity ?? '') };
  }
  return { title: '', body: text(v), severity: '' };
}

function findAction(actions, wanted) {
  if (!Array.isArray(actions) || !present(wanted)) return null;
  const hit = actions.find((a) => a && typeof a === 'object' && [a.action_id, a.id, a.actionId].some((k) => present(k) && String(k) === String(wanted)));
  if (hit) return hit;
  const idx = Number(wanted);
  return Number.isInteger(idx) && idx >= 0 && idx < actions.length ? actions[idx] : null;
}

/**
 * The human label and the judge pair for one row. cr = the bot suggestion. eng = the developer action the human matched,
 * else the one the LLM judge matched, else all actions. candidateSource records which. Uncertain rows have human = null.
 */
export function rowToPair(row) {
  const d = String(row.human_match_decision ?? '').trim().toLowerCase();
  const human = d === 'yes' ? 'yes' : d === 'no' ? 'no' : null;
  const actions = parseMaybe(row.developer_actions);
  let candidateSource = 'human';
  let action = findAction(actions, row.human_matched_action_id);
  if (!action) { candidateSource = 'judge'; action = findAction(actions, row.judge_matched_action_id); }
  const eng = action ? toFinding(action) : (candidateSource = 'all', { title: 'all developer actions', body: text(actions), severity: '' });
  return { pairId: String(row.task_id), human, candidateSource, pair: { cr: toFinding(row.bot_suggestion), eng, hunk: '' } };
}

// ---- sample, interval ----------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded shuffle of the ids (sorted first, so row order never matters), first n. A larger n extends a smaller sample. */
export function sampleIds(ids, n, seed) {
  const a = [...new Set(ids.map(String))].sort();
  const rnd = mulberry32(Number(seed));
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Wilson score interval for k of n at z (default 95%). { lo, hi } or null for n = 0. */
export function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = k / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// ---- ledger --------------------------------------------------------------------------------------------------------

export function readOwnLedger(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (l.trim() === '') continue;
    try { rows.push(JSON.parse(l)); } catch { /* a torn line is skipped */ }
  }
  return rows;
}
const append = (file, row) => { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(row)}\n`); };

/** Start rows of one Chicago day. A row with an unreadable time counts, so the cap errs safe. */
export function usedToday(rows, ms) {
  const day = chicagoDay(ms);
  return rows.filter((r) => r.phase === 'start' && (Number.isNaN(Date.parse(r.ts)) || chicagoDay(Date.parse(r.ts)) === day)).length;
}

/** pairId -> judged end row, for one dataset. An end row with an error is not judged, so the pair is retried. */
export function judgedMap(rows, dataset) {
  const m = new Map();
  for (const r of rows) if (r.phase === 'end' && r.dataset === dataset && r.judge && !r.error) m.set(r.pairId, r);
  return m;
}

export function summarize(records, extra = {}) {
  const n = records.length;
  const agree = records.filter((r) => r.agree).length;
  const ci = wilson(agree, n);
  return { n, agree, agreement: n ? agree / n : null, ci95: ci ? [ci.lo, ci.hi] : null, notMeasured: ['real'], ...extra };
}

// ---- rows from disk ------------------------------------------------------------------------------------------------

/** Rows of a pulled file. JSON and JSONL only. Parquet needs a reader we do not have: PullRefusal. Checks the manifest hash. */
export function loadRows({ id, sha, file }, { root = DEFAULT_ROOT } = {}) {
  assertPinned({ id, sha, file });
  const dir = path.join(root, datasetDirName(id, sha));
  const filePath = path.join(dir, ...file.split('/'));
  if (!existsSync(filePath)) throw new PullRefusal(`${filePath} is missing. Run external-pull.mjs first.`);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.parquet') throw new PullRefusal(`${file} is parquet and no parquet reader is installed (no pyarrow, no Node package). Provide a .jsonl copy next to it, or Dave approves a reader.`);
  const buf = readFileSync(filePath);
  const manifestPath = path.join(dir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (m.file === file && m.sha256 !== createHash('sha256').update(buf).digest('hex')) throw new PullRefusal(`${file} does not match the sha256 in manifest.json. Pull it again.`);
  }
  const s = buf.toString('utf8');
  if (ext === '.jsonl') return s.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  if (ext === '.json') { const j = JSON.parse(s); return Array.isArray(j) ? j : j.rows ?? []; }
  throw new PullRefusal(`unsupported file type ${ext}: JSON or JSONL only.`);
}

// ---- run -----------------------------------------------------------------------------------------------------------

/**
 * deps (tests inject all of them): rows, runClaudeFn, now, ledgerPath, outDir, root, headlessDeps, stdout, stderr.
 * Returns { code, ... }. Code 2 is a refusal.
 */
export async function run(opts, deps = {}) {
  const { id, sha, file, sample = 50, seed = DEFAULT_SEED, dailyShare = 10, dryRun = false, showPrompts = 3 } = opts;
  const stdout = deps.stdout ?? ((s) => console.log(s));
  const stderr = deps.stderr ?? ((s) => console.error(s));
  const now = deps.now ?? Date.now;
  const ledgerPath = deps.ledgerPath ?? DEFAULT_LEDGER;
  const outDir = deps.outDir ?? DEFAULT_OUT_DIR;
  const runClaudeFn = deps.runClaudeFn ?? runClaude;
  try {
    assertPinned({ id, sha, file });
    const rows = deps.rows ?? loadRows({ id, sha, file }, { root: deps.root });
    const dataset = `${id}@${sha}`;
    const all = rows.map(rowToPair);
    const decisive = all.filter((p) => p.human);
    const uncertain = all.length - decisive.length;
    const byId = new Map(decisive.map((p) => [p.pairId, p]));
    const ids = sampleIds([...byId.keys()], sample, seed);

    const ledger = readOwnLedger(ledgerPath);
    const judged = judgedMap(ledger, dataset);
    const pending = ids.filter((i) => !judged.has(i));
    const used = usedToday(ledger, now());
    const allowed = Math.max(0, Math.min(dailyShare - used, pending.length));
    stdout(`plan: dataset ${dataset} file ${file}; rows ${all.length}, decisive ${decisive.length}, uncertain excluded ${uncertain}; sample ${ids.length} seed ${seed}; already judged ${ids.length - pending.length}, pending ${pending.length}; external calls today ${used}/${dailyShare}, this run ${dryRun ? 0 : allowed} (dry-run would allow ${allowed}); headless calls made: ${dryRun ? 0 : 'see below'}`);

    if (dryRun) {
      for (const i of pending.slice(0, showPrompts)) stdout(`--- prompt for pair ${i} (human: ${byId.get(i).human}, candidate: ${byId.get(i).candidateSource}) ---\n${judgePrompt(byId.get(i).pair)}`);
      return { code: 0, dryRun: true, planned: allowed, pending: pending.length, headlessCalls: 0 };
    }
    if (pending.length > 0 && allowed === 0) {
      stderr(`external-judge refused: ${used} external judge calls already started today (daily share ${dailyShare}). Run again tomorrow (Chicago time).`);
      return { code: 2, reason: 'daily-share', used };
    }

    const runJudge = (prompt) => runClaudeFn({ prompt, model: 'sonnet', timeoutMs: 180_000, purpose: 'external-judge' }, { ...(deps.headlessDeps ?? {}), sessionId: SESSION_ID });
    let calls = 0;
    let stopped = null;
    for (const pairId of pending.slice(0, allowed)) {
      const p = byId.get(pairId);
      append(ledgerPath, { ts: new Date(now()).toISOString(), day: chicagoDay(now()), phase: 'start', dataset, pairId, sessionId: SESSION_ID });
      calls += 1;
      const res = await judgePair(p.pair, { runJudge });
      if (!res.ok) {
        append(ledgerPath, { ts: new Date(now()).toISOString(), phase: 'end', dataset, pairId, error: res.error });
        if (res.error === 'cap') { stopped = 'cap'; break; }
        continue;
      }
      append(ledgerPath, { ts: new Date(now()).toISOString(), phase: 'end', dataset, pairId, human: p.human, judge: res.sameIssue, confidence: res.confidence, candidateSource: p.candidateSource });
    }

    const final = judgedMap(readOwnLedger(ledgerPath), dataset);
    const records = ids.filter((i) => final.has(i)).map((i) => {
      const r = final.get(i);
      return { pairId: i, human: r.human, judge: r.judge, agree: r.human === r.judge, candidateSource: r.candidateSource, confidence: r.confidence ?? null };
    });
    const out = {
      dataset, file, seed, sampleRequested: sample, sampleIds: ids, uncertainExcluded: uncertain, pendingAfterRun: ids.length - records.length,
      generatedAt: new Date(now()).toISOString(), pairs: records, summary: summarize(records),
    };
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${chicagoDay(now())}-hf-judge-precheck.json`);
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
    stdout(`external-judge: ${calls} judge calls this run; ${records.length}/${ids.length} judged; agreement ${out.summary.agree}/${out.summary.n}${stopped ? `; stopped: shared headless ${stopped}` : ''}`);
    stdout(`wrote ${outPath}`);
    return { code: stopped ? 2 : 0, calls, outPath, out };
  } catch (e) {
    if (e instanceof PullRefusal) { stderr(`external-judge refused: ${e.message}`); return { code: 2, reason: 'refused' }; }
    stderr(`external-judge failed: ${e.message}`);
    return { code: 1 };
  }
}

export function parseArgs(argv) {
  const o = { ...DEFAULT_DATASET };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--sample') o.sample = Number(next());
    else if (a === '--seed') o.seed = Number(next());
    else if (a === '--daily-share') o.dailyShare = Number(next());
    else if (a === '--show-prompts') o.showPrompts = Number(next());
    else if (a === '--root') o.root = next();
    else if (a === '--id' || a === '--sha' || a === '--file') o[a.slice(2)] = next();
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['sample', 'seed', 'dailyShare', 'showPrompts']) if (k in o && !Number.isInteger(o[k])) throw new Error(`--${k} needs an integer`);
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`external-judge: ${e.message}`); process.exit(2); }
  run(opts, { root: opts.root }).then((r) => process.exit(r.code));
}
