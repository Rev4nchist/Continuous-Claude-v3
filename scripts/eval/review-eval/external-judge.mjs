// Step A judge pre-check (decision doc 2026-11-02, sections 3.1-3.3): does our judge agree with human labels on Code Review Bench task 1?
// - sameIssue only. The rows have no path, line or hunk, so the hunk is empty and `real` is reported as not measured.
// - Reuses judgePair from judge.mjs and runClaude from scripts/lib/headless.mjs (key strip, shared 30/day Chicago cap).
// - Headless session id is "review-external", purpose "external-judge". It never consumes the P0 eval budget (session "review-eval").
// - Own ledger .claude/cache/hf-datasets/external-judge-ledger.jsonl: at most --daily-share (default 10) judge calls per Chicago day.
// - Resumable: a pair with a judged end row in the ledger is skipped, on this day or a later one. Only when the end row's candidateSource is the one the pair has now: an old row judged on another prompt (source all, or none recorded) is judged again.
// - Pairs with no candidate action leave the sample before the shuffle. A sample drawn before that change is not comparable with a new one for the same seed.
// - --dry-run reads rows and the ledger, prints the plan and prompts, makes 0 headless calls and writes nothing. Use --show-prompts 0 on real data.
// - --model opus|sonnet (default JUDGE_MODEL, opus, effort high). Ledger rows carry the model; each model has its own verdicts and score.
//   A call whose served model does not match is an error row and stops the run. --cap N raises the shared headless cap for this run only.
//   --stop-on-error stops after the first error row. The report is <day>-hf-judge-precheck-<model>.json and names the head SHA.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chicagoDay, runClaude } from '../../lib/headless.mjs';
import { cohenKappa } from './agreement.mjs';
import { judgePair, judgePrompt } from './judge.mjs';
import { assertPinned, datasetDirName, DEFAULT_ROOT, PullRefusal } from './external-pull.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_LEDGER = path.join(DEFAULT_ROOT, 'external-judge-ledger.jsonl');
export const DEFAULT_OUT_DIR = path.join(REPO, '.claude', 'cache', 'e2e');
export const SESSION_ID = 'review-external';
export const DEFAULT_SEED = 20261102;
export const DEFAULT_DATASET = { id: 'code-review-bench/code-review-bench', sha: '343ecc5b815904aea4a1063a898f2325b76f97d0', file: 'human_annotations_task1.parquet' };
// The judge model (Dave, 2026-11-13: Opus 5.5 at effort high, not Sonnet). 'sonnet' stays selectable to read and extend the old result.
export const JUDGE_MODEL = 'opus';
export const JUDGE_EFFORT = 'high';
const MODELS = ['opus', 'sonnet'];
// The served model that an opus run must report. An older Opus or no served model is a stop (seat condition, 2026-11-13).
const SERVED = { opus: /^claude-opus-5-5\b/, sonnet: /^claude-sonnet-/ };
// Ledger rows written before 2026-11-13 have no model field. All of them are Sonnet runs (the model was hard-coded), in this ledger only.
const LEGACY_MODEL = 'sonnet';
const rowModel = (r) => r.model ?? LEGACY_MODEL;

/** The model names in the modelUsage of the claude -p result line, joined by comma; null when there is none. */
export function servedModelOf(stdout) {
  for (const l of String(stdout ?? '').split(/\r?\n/).reverse()) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object' && o.type === 'result') {
        const names = o.modelUsage && typeof o.modelUsage === 'object' ? Object.keys(o.modelUsage) : [];
        return names.length ? names.join(',') : null;
      }
    } catch { /* not the result line */ }
  }
  return null;
}

/** Every served model name matches the requested model (a run can report a helper model too: then all must match). */
export function servedMatches(model, served) {
  if (!served) return false;
  return served.split(',').every((n) => SERVED[model].test(n));
}

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
  // By id only. A wanted id that matches no action is not a list position: a wrong action would skew the agreement.
  return actions.find((a) => a && typeof a === 'object' && [a.action_id, a.id, a.actionId].some((k) => present(k) && String(k) === String(wanted))) ?? null;
}

const words = (s) => new Set(String(s ?? '').toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
const findingText = (f) => `${f.title} ${f.body}`;

/**
 * One action of the list for a no row with no old-judge match. It never reads the label. The action with the most distinct words
 * (3 characters or more) in common with the finding text wins, so the negative is a hard case, not a random one. Between equal
 * actions task_id decides: sha256 of task_id as an integer, modulo their count, in list order. null for an empty list.
 */
export function pickAction(taskId, actions, text = '') {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const want = words(text);
  const scores = actions.map((a) => { let n = 0; for (const w of words(findingText(toFinding(a)))) if (want.has(w)) n += 1; return n; });
  const best = Math.max(...scores);
  const top = actions.filter((_, i) => scores[i] === best);
  const idx = Number(BigInt(`0x${createHash('sha256').update(String(taskId)).digest('hex')}`) % BigInt(top.length));
  return top[idx];
}

/**
 * The human label and the judge pair for one row. cr = the bot suggestion. eng = ONE developer action for every row, so the prompt
 * shape does not show the label. yes: the action the human matched. no: the action the old judge matched, else one picked by
 * pickAction. candidateSource is human, judge, picked or none. none (no action to show) has pair null and is left out of the sample.
 * Uncertain rows have human = null and source none.
 */
export function rowToPair(row) {
  const d = String(row.human_match_decision ?? '').trim().toLowerCase();
  const human = d === 'yes' ? 'yes' : d === 'no' ? 'no' : null;
  const actions = parseMaybe(row.developer_actions);
  const pairId = String(row.task_id);
  let action = null;
  let candidateSource = 'none';
  if (human === 'yes') {
    action = findAction(actions, row.human_matched_action_id);
    if (action) candidateSource = 'human';
  } else if (human === 'no') {
    action = findAction(actions, row.judge_matched_action_id);
    if (action) candidateSource = 'judge';
    else { action = pickAction(pairId, actions, findingText(toFinding(row.bot_suggestion))); if (action) candidateSource = 'picked'; }
  }
  const pair = action ? { cr: toFinding(row.bot_suggestion), eng: toFinding(action), hunk: '' } : null;
  return { pairId, human, candidateSource, pair };
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

/** pairId -> judged end row, for one dataset and one model. An end row with an error is not judged, so the pair is retried. */
export function judgedMap(rows, dataset, model = JUDGE_MODEL) {
  const m = new Map();
  for (const r of rows) if (r.phase === 'end' && r.dataset === dataset && r.judge && !r.error && rowModel(r) === model) m.set(r.pairId, r);
  return m;
}

/** The commit that runs this script (the report names the code that made the verdicts). null when git is not reachable. */
function headOf() {
  try { return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null; } catch { return null; }
}

const kappaOf = (records) => { const k = cohenKappa(records.map((r) => [r.human, r.judge])); return Number.isFinite(k) ? k : null; };

/**
 * n, agree, agreement, ci95, kappa (human against judge on sameIssue; null when undefined), bySource {n, agree, agreement} and hard
 * {n, agree, agreement, kappa}: the same numbers over the records whose source is not picked (picked negatives are built cases).
 * No kappa per source: a source holds one human label (human = yes, judge and picked = no), so its kappa is 0 or undefined.
 */
export function summarize(records, extra = {}) {
  const n = records.length;
  const agree = records.filter((r) => r.agree).length;
  const ci = wilson(agree, n);
  const hardRecs = records.filter((r) => r.candidateSource !== 'picked');
  const hardAgree = hardRecs.filter((r) => r.agree).length;
  const hard = { n: hardRecs.length, agree: hardAgree, agreement: hardRecs.length ? hardAgree / hardRecs.length : null, kappa: kappaOf(hardRecs) };
  const bySource = {};
  for (const r of records) {
    const g = (bySource[r.candidateSource ?? 'unknown'] ??= { n: 0, agree: 0, agreement: null });
    g.n += 1;
    if (r.agree) g.agree += 1;
    g.agreement = g.agree / g.n;
  }
  const rate = (subset) => { const k = subset.filter((r) => r.agree).length; const w = wilson(k, subset.length); return { k, n: subset.length, rate: subset.length ? k / subset.length : null, ci95: w ? [w.lo, w.hi] : null }; };
  const high = records.filter((r) => r.confidence >= 4);
  const highConfidence = { n: high.length, agree: high.filter((r) => r.agree).length, humanYes: high.filter((r) => r.human === 'yes').length };
  return {
    n, agree, agreement: n ? agree / n : null, ci95: ci ? [ci.lo, ci.hi] : null, kappa: kappaOf(records), bySource, hard,
    tpr: rate(records.filter((r) => r.human === 'yes')), tnr: rate(records.filter((r) => r.human === 'no')), highConfidence, notMeasured: ['real'], ...extra,
  };
}

/** Paired counts over the pairs that both models judged: both agree with the human, only this model, only the other, neither. */
export function pairedCounts(thisRecs, otherRecs) {
  const other = new Map(otherRecs.map((r) => [r.pairId, r]));
  const p = { n: 0, bothAgree: 0, onlyThis: 0, onlyOther: 0, bothWrong: 0 };
  for (const r of thisRecs) {
    const o = other.get(r.pairId);
    if (!o) continue;
    p.n += 1;
    if (r.agree && o.agree) p.bothAgree += 1; else if (r.agree) p.onlyThis += 1; else if (o.agree) p.onlyOther += 1; else p.bothWrong += 1;
  }
  return p;
}

const fmt3 = (x) => (x === null || x === undefined ? 'undefined' : x.toFixed(3));
const splitLine = (by) => `by source: ${Object.entries(by).map(([s, g]) => `${s} n=${g.n} agree ${g.agree} (${fmt3(g.agreement)})`).join('; ') || 'none'}. kappa by source: not defined (each source holds one human label).${by.picked ? ' Note: picked negatives are built cases, not human-paired cases (the action with the most words in common with the finding).' : ''}`;

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
  const { id, sha, file, sample = 50, seed = DEFAULT_SEED, dailyShare = 10, dryRun = false, showPrompts = 3, model = JUDGE_MODEL, cap = null, stopOnError = false } = opts;
  if (!MODELS.includes(model)) { (deps.stderr ?? console.error)(`external-judge: --model must be one of ${MODELS.join(', ')}`); return { code: 1 }; }
  const otherModel = MODELS.find((m) => m !== model);
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
    const labelled = all.filter((p) => p.human);
    const decisive = labelled.filter((p) => p.candidateSource !== 'none');
    const uncertain = all.length - labelled.length;
    const noCandidate = labelled.length - decisive.length;
    const noCandidateByLabel = { yes: 0, no: 0 };
    for (const p of labelled) if (p.candidateSource === 'none') noCandidateByLabel[p.human] += 1;
    const byId = new Map(decisive.map((p) => [p.pairId, p]));
    const ids = sampleIds([...byId.keys()], sample, seed);

    const ledger = readOwnLedger(ledgerPath);
    // An end row counts only when it was judged on the candidate the pair has now.
    const fresh = (m) => new Map([...m].filter(([i, r]) => byId.get(i)?.candidateSource === r.candidateSource));
    const judgedAny = judgedMap(ledger, dataset, model);
    const judged = fresh(judgedAny);
    const staleRejudged = ids.filter((i) => judgedAny.has(i) && !judged.has(i)).length;
    const pending = ids.filter((i) => !judged.has(i));
    const used = usedToday(ledger, now());
    const allowed = Math.max(0, Math.min(dailyShare - used, pending.length));
    stdout(`plan: model ${model} effort ${JUDGE_EFFORT}${cap ? ` cap ${cap} (this run)` : ''}; dataset ${dataset} file ${file}; rows ${all.length}, decisive ${decisive.length}, uncertain excluded ${uncertain}, no candidate ${noCandidate} (yes ${noCandidateByLabel.yes}, no ${noCandidateByLabel.no}); sample ${ids.length} seed ${seed}; already judged ${ids.length - pending.length}, pending ${pending.length}, stale ${staleRejudged} (judged on another prompt, judged again); external calls today ${used}/${dailyShare}, this run ${dryRun ? 0 : allowed} (dry-run would allow ${allowed}); headless calls made: ${dryRun ? 0 : 'see below'}`);

    if (dryRun) {
      for (const i of pending.slice(0, showPrompts)) stdout(`--- prompt for pair ${i} (human: ${byId.get(i).human}, candidate: ${byId.get(i).candidateSource}) ---\n${judgePrompt(byId.get(i).pair)}`);
      return { code: 0, dryRun: true, planned: allowed, pending: pending.length, headlessCalls: 0 };
    }
    if (pending.length > 0 && allowed === 0) {
      stderr(`external-judge refused: ${used} external judge calls already started today (daily share ${dailyShare}). Run again tomorrow (Chicago time).`);
      return { code: 2, reason: 'daily-share', used };
    }

    // The served model of the last call, read from its stdout inside the runJudge closure (judgePair keeps only the verdict).
    let lastServed = null;
    const headlessDeps = { ...(deps.headlessDeps ?? {}), sessionId: SESSION_ID, ...(cap ? { cap } : {}) };
    const runJudge = async (prompt) => {
      const res = await runClaudeFn({ prompt, model, effort: JUDGE_EFFORT, timeoutMs: 180_000, purpose: 'external-judge' }, headlessDeps);
      lastServed = servedModelOf(res?.stdout);
      return res;
    };
    let calls = 0;
    let stopped = null;
    for (const pairId of pending.slice(0, allowed)) {
      const p = byId.get(pairId);
      append(ledgerPath, { ts: new Date(now()).toISOString(), day: chicagoDay(now()), phase: 'start', dataset, pairId, sessionId: SESSION_ID, model });
      calls += 1;
      lastServed = null;
      const res = await judgePair(p.pair, { runJudge });
      const endBase = { ts: new Date(now()).toISOString(), phase: 'end', dataset, pairId, model, servedModel: lastServed };
      if (!res.ok) {
        append(ledgerPath, { ...endBase, error: res.error });
        if (res.error === 'cap') { stopped = 'shared headless cap'; break; }
        if (stopOnError) { stopped = `error ${res.error}`; break; }
        continue;
      }
      if (!servedMatches(model, lastServed)) {
        // A verdict from another model is never counted: an error row (the pair is retried) and a stop, flag or not.
        append(ledgerPath, { ...endBase, error: 'served-model' });
        stopped = 'served-model';
        break;
      }
      append(ledgerPath, { ...endBase, human: p.human, judge: res.sameIssue, confidence: res.confidence, candidateSource: p.candidateSource });
    }

    const after = readOwnLedger(ledgerPath);
    const recordsOf = (m) => { const final = fresh(judgedMap(after, dataset, m)); return ids.filter((i) => final.has(i)).map((i) => {
      const r = final.get(i);
      return { pairId: i, human: r.human, judge: r.judge, agree: r.human === r.judge, candidateSource: r.candidateSource, confidence: r.confidence ?? null };
    }); };
    const records = recordsOf(model);
    const otherRecs = recordsOf(otherModel);
    const headSha = deps.headSha ?? headOf();
    const out = {
      model, effort: JUDGE_EFFORT, headSha,
      dataset, file, seed, sampleRequested: sample, sampleIds: ids, uncertainExcluded: uncertain, noCandidate, noCandidateByLabel, staleRejudged, pendingAfterRun: ids.length - records.length,
      generatedAt: new Date(now()).toISOString(), pairs: records, summary: summarize(records),
      compare: { model: otherModel, summary: summarize(otherRecs), paired: pairedCounts(records, otherRecs) },
    };
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${chicagoDay(now())}-hf-judge-precheck-${model}.json`);
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
    const s = out.summary;
    const o = out.compare.summary;
    const pc = out.compare.paired;
    stdout(`wrote ${outPath}`);
    stdout(splitLine(s.bySource));
    stdout(`tpr ${s.tpr.k}/${s.tpr.n} (${fmt3(s.tpr.rate)}); tnr ${s.tnr.k}/${s.tnr.n} (${fmt3(s.tnr.rate)}); confidence 4+: n ${s.highConfidence.n}, agree ${s.highConfidence.agree}, human yes ${s.highConfidence.humanYes}`);
    stdout(`compare ${otherModel}: n ${o.n}; agreement ${o.agree}/${o.n} (${fmt3(o.agreement)}); kappa: ${fmt3(o.kappa)}; paired n ${pc.n}: both agree ${pc.bothAgree}, only ${model} ${pc.onlyThis}, only ${otherModel} ${pc.onlyOther}, both wrong ${pc.bothWrong}`);
    stdout(`external-judge [${model} @ ${String(headSha ?? 'unknown').slice(0, 8)}]: ${calls} judge calls this run; ${records.length}/${ids.length} judged; n ${s.n}; agreement ${s.agree}/${s.n} (${fmt3(s.agreement)}); kappa: ${fmt3(s.kappa)}; hard (not picked): n ${s.hard.n}; agreement ${s.hard.agree}/${s.hard.n} (${fmt3(s.hard.agreement)}); kappa: ${fmt3(s.hard.kappa)}; real: not measured${stopped ? `; stopped: ${stopped}` : ''}`);
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
    else if (a === '--model') { o.model = next(); if (!MODELS.includes(o.model)) throw new Error(`--model must be one of ${MODELS.join(', ')}`); }
    else if (a === '--cap') o.cap = Number(next());
    else if (a === '--stop-on-error') o.stopOnError = true;
    else if (a === '--root') o.root = next();
    else if (a === '--out-dir') o.outDir = next();
    else if (a === '--id' || a === '--sha' || a === '--file') o[a.slice(2)] = next();
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['sample', 'seed', 'dailyShare', 'showPrompts', 'cap']) if (k in o && !Number.isInteger(o[k])) throw new Error(`--${k} needs an integer`);
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`external-judge: ${e.message}`); process.exit(2); }
  // --root moves the dataset cache AND the lane ledger (a run from a worktree reads the primary checkout's cache and ledger).
  const cli = { root: opts.root, ...(opts.root ? { ledgerPath: path.join(opts.root, 'external-judge-ledger.jsonl') } : {}), ...(opts.outDir ? { outDir: opts.outDir } : {}) };
  run(opts, cli).then((r) => process.exit(r.code));
}
