#!/usr/bin/env node
// Transition shadow protocol: pair every CodeRabbit round with an engine run at the same 40-hex sha, score each band, decide demotion.
// Subcommands: retro | sync | scorecard | decide. Exit 0 ok, 1 failed, 2 refused, 3 repromote. It never blocks READY or land.
// State root: ~/.claude/state/local-review-shadow (override: CCV3_SHADOW_ROOT or --root). Replay output never goes under local-review/.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeRabbitOutsideFindings, codeRabbitSeverity, isCodeRabbitUser } from '../../github/review-status.mjs';
import { loadConfig, underLocalReview } from './config.mjs';
import { engineVersion, promptSha256 } from './freeze.mjs';
import { defaultGh, ghList, inlineComments, roundData, roundsFrom } from './github.mjs';
import { isoWeek } from './labels.mjs';
import { judgeSameIssue, resolveJudged } from './judge.mjs';
import { foldSev, isMajor, matchFindings } from './match.mjs';
import { makeGit, replayRun as realReplayRun } from './replay.mjs';

export { judgeSameIssue, matchFindings };
export const SHADOW_ROOT = process.env.CCV3_SHADOW_ROOT || path.join(os.homedir(), '.claude', 'state', 'local-review-shadow');
export const PAIR_STATES = ['cr_pending', 'engine_pending', 'paired', 'void_sha', 'void_partial', 'excluded', 'skipped'];
// Final states: a stored row in one of these is never re-run or replaced (spec section 3).
const FINAL_STATES = new Set(PAIR_STATES.filter((s) => s !== 'cr_pending' && s !== 'engine_pending'));
export const crRounds = roundsFrom;

const lc = (s) => String(s ?? '').toLowerCase();
const REPO = 'Rev4nchist/Continuous-Claude-v3';

// ---------- CodeRabbit side ----------

/** Inline roots of this round (by original_commit_id, original_* lines) and the outside-diff findings of its review body. */
export function crFindings({ round, review, inline = [] }) {
  const out = [];
  for (const c of inline) {
    if (!isCodeRabbitUser(c?.user) || c.in_reply_to_id != null || lc(c.original_commit_id) !== lc(round.sha40)) continue;
    const end = c.original_line ?? c.line ?? null;
    const start = c.original_start_line ?? end;
    const body = String(c.body ?? '');
    out.push({ src: 'cr', id: String(c.id), file: c.path, start, end, sev: codeRabbitSeverity(body), inDiff: true, title: body.split(/\r?\n/).find((l) => l.trim() && !/^<|^\*\*<picture/.test(l.trim()))?.replace(/[*_`]/g, '').slice(0, 160) ?? '', body });
  }
  if (!review) return out;
  const body = String(review.body ?? '');
  const { findings } = codeRabbitOutsideFindings({ reviews: [review] });
  let from = 0;
  for (const f of findings) {
    const at = body.indexOf(f.id);
    const segment = at >= 0 ? body.slice(from, at) : '';
    if (at >= 0) from = at;
    const m = /^(.*?):(\d+)(?:[-–](\d+))?$/.exec(String(f.location ?? ''));
    out.push({ src: 'cr', id: f.id, file: m ? m[1] : null, start: m ? Number(m[2]) : null, end: m ? Number(m[3] ?? m[2]) : null, sev: codeRabbitSeverity(segment), inDiff: false, title: '', body: segment.slice(0, 2000) });
  }
  return out;
}

/** The range a round covers: round 1 from merge-base(sha40, origin/main), round k from round k-1. git(args) => { status, stdout }. */
export function crRange(rounds, i, { git }) {
  const head = rounds[i].sha40;
  if (i > 0) return { base: rounds[i - 1].sha40, head };
  const r = git(['merge-base', head, 'origin/main']);
  return { base: r.status === 0 ? r.stdout.trim() : null, head };
}

// ---------- pair state ----------

/** { state, reason }. round: a CR round or null; engine: { sha40, coverage, timedOut, failed } or null; pr: { author, merged, closed, drawnAt, shaGone }. */
export function pairState({ round, engine, pr = {}, now, ttlMs }) {
  if (round?.notice) return { state: 'excluded', reason: `notice: ${round.notice}` };
  if (round?.tooManyFiles) return { state: 'excluded', reason: 'too many files' };
  if (/dependabot/i.test(pr.author ?? '')) return { state: 'excluded', reason: 'dependabot' };
  if (!round) {
    if (pr.merged) return { state: 'skipped', reason: 'merged' };
    if (pr.closed) return { state: 'skipped', reason: 'closed' };
    if (pr.drawnAt != null && now - pr.drawnAt > ttlMs) return { state: 'skipped', reason: 'ttl' };
    return { state: 'cr_pending', reason: null };
  }
  if (!engine) return pr.shaGone ? { state: 'void_sha', reason: 'sha gone' } : { state: 'engine_pending', reason: 'no engine record' };
  if (engine.sha40 !== round.sha40) return pr.shaGone ? { state: 'void_sha', reason: 'engine head differs and the CR sha is gone' } : { state: 'engine_pending', reason: 'engine head differs' };
  const cov = engine.coverage ?? {};
  if (engine.timedOut || engine.failed) return { state: 'void_partial', reason: engine.timedOut ? 'timed out' : 'failed' };
  if (Number.isFinite(cov.selected) && Number.isFinite(cov.reviewed) && cov.reviewed < cov.selected) return { state: 'void_partial', reason: 'part coverage' };
  if (Number.isFinite(round.filesSelected) && Number.isFinite(cov.selected) && round.filesSelected !== cov.selected) return { state: 'void_partial', reason: 'file count differs from CR' };
  return { state: 'paired', reason: null };
}

/** Where a replayed engine record goes. Never under a local-review/ folder (LR-PIN reads there). */
export function engineRecordPath({ pr, sha40 }, { root = SHADOW_ROOT } = {}) {
  if (underLocalReview(root)) throw new Error(`the shadow root must not sit under local-review: ${root}`);
  return path.join(root, String(pr), `${sha40}.json`);
}

// ---------- scoring ----------

const BAND_DEFAULT = { holdoutRecall: 0.8, precision: 0.78, minMajors: 20, minLabels: 30 };

/** Clusters of one pair: each match is one cluster, each unmatched finding is its own. */
function clustersOf(pair) {
  const cr = new Map((pair.cr ?? []).map((f) => [f.id, f]));
  const eng = new Map((pair.eng ?? []).map((f) => [f.id, f]));
  const out = [];
  const usedC = new Set();
  const usedE = new Set();
  for (const m of pair.matches ?? []) {
    if (!cr.has(m.crId) || !eng.has(m.engId)) continue;
    usedC.add(m.crId);
    usedE.add(m.engId);
    out.push({ cr: [cr.get(m.crId)], eng: [eng.get(m.engId)] });
  }
  for (const [id, f] of cr) if (!usedC.has(id)) out.push({ cr: [f], eng: [] });
  for (const [id, f] of eng) if (!usedE.has(id)) out.push({ cr: [], eng: [f] });
  return out;
}

/** BandScore for one band and one engine version. Other versions are out of every count. */
export function scoreBand(pairs, labels, opts) {
  const { band, engineVersion: version } = opts;
  const mine = pairs.filter((p) => p.band === band && p.engineVersion === version);
  const states = Object.fromEntries(PAIR_STATES.map((s) => [s, 0]));
  const byKind = { sample: 0, required: 0, retro: 0 };
  for (const p of mine) { states[p.state] = (states[p.state] ?? 0) + 1; byKind[p.kind] = (byKind[p.kind] ?? 0) + 1; }
  const samples = mine.filter((p) => p.kind === 'sample' && (p.state === 'paired' || p.state === 'skipped'));
  const skipRate = samples.length ? samples.filter((p) => p.state === 'skipped').length / samples.length : 0;
  const sampleStarved = skipRate > 0.5 && (opts.priorSkipRate ?? 0) > 0.5;

  const verdictOf = new Map(labels.filter((l) => l.by === 'dave' || l.by === 'dataset').map((l) => [l.findingId, lc(l.verdict)]));
  const paired = mine.filter((p) => p.state === 'paired').sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const isReal = (f) => verdictOf.get(f.id) === 'real';
  let union = 0; let engFound = 0; let crFound = 0; let unionIn = 0; let engIn = 0; let downgrades = 0;
  let real = 0; let noise = 0; let unverified = 0;
  const missedPairs = new Set();
  for (const p of paired) {
    for (const m of p.matches ?? []) {
      const c = (p.cr ?? []).find((f) => f.id === m.crId);
      const e = (p.eng ?? []).find((f) => f.id === m.engId);
      if (c && e && isMajor(c.sev) && !isMajor(e.sev)) downgrades += 1;
    }
    for (const cl of clustersOf(p)) {
      const crHas = cl.cr.some((f) => isMajor(f.sev));
      const engHas = cl.eng.some((f) => isMajor(f.sev));
      if (![...cl.cr, ...cl.eng].some(isReal) || !(crHas || engHas)) continue;
      const inDiff = [...cl.cr, ...cl.eng].some((f) => f.inDiff);
      union += 1; if (inDiff) unionIn += 1;
      if (engHas) { engFound += 1; if (inDiff) engIn += 1; }
      if (crHas) crFound += 1;
      if (crHas && !engHas) missedPairs.add(p);
    }
    for (const f of p.eng ?? []) {
      const v = verdictOf.get(f.id);
      if (v === 'real') real += 1; else if (v === 'noise') noise += 1; else unverified += 1;
    }
  }
  const recent = paired.filter((p) => p.kind === 'sample').slice(-10);
  const recentMisses = recent.filter((p) => missedPairs.has(p)).length;
  const holdout = opts.holdout && opts.holdout.engineVersion === version ? opts.holdout : null;
  const pairedPerWeek = opts.pairedPerWeek ?? 0;
  const score = {
    pairs: states, byKind, skipRate, sampleStarved, majorsUnion: union, majorsCumulative: union + (holdout?.majors ?? 0),
    engineRecall: union ? engFound / union : null, engineRecallInDiff: unionIn ? engIn / unionIn : null, crRecall: union ? crFound / union : null,
    holdoutRecall: holdout ? holdout.recall : null, precision: { real, noise, unverified, value: real + noise > 0 ? real / (real + noise) : null },
    severityDowngrades: downgrades, securityEscapes4w: opts.securityEscapes4w ?? 0, waivers4w: opts.waivers4w ?? 0, escapeRate4w: opts.escapeRate4w ?? null,
    escapeBaseline: opts.escapeBaseline ?? null, recentMisses, grokRuns: paired.filter((p) => p.engineSource === 'shadow').length, judgeRuns: opts.judgeRuns ?? 0,
    weeksTo20Majors: pairedPerWeek > 0 ? Math.max(0, 20 - (union + (holdout?.majors ?? 0))) / (pairedPerWeek * 0.55) : null,
  };
  const d = decideBand(score, opts.bar ?? BAND_DEFAULT, opts.prior);
  return { ...score, verdict: d.verdict, failed: d.failed };
}

/** { verdict: 'hold' | 'eligible' | 'repromote', failed: [row], proposal }. Re-promotion wins over every other row. */
export function decideBand(score, bar = BAND_DEFAULT, prior) {
  const failed = [];
  if (score.holdoutRecall == null || score.holdoutRecall < bar.holdoutRecall) failed.push('holdoutRecall');
  if (score.engineRecall == null || score.crRecall == null || score.engineRecall < score.crRecall) failed.push('shadowRecall');
  const labelled = (score.precision?.real ?? 0) + (score.precision?.noise ?? 0);
  if (score.precision?.value == null || score.precision.value < bar.precision || labelled < (bar.minLabels ?? 0)) failed.push('precision');
  if (!(score.majorsCumulative >= bar.minMajors) || score.sampleStarved) failed.push('minMajors');
  if (score.securityEscapes4w > 0) failed.push('securityEscape');
  if (score.waivers4w > 0) failed.push('waivers');
  if (score.escapeRate4w != null && score.escapeRate4w > (score.escapeBaseline ?? 0)) failed.push('escapeRate');
  const repromote = score.securityEscapes4w >= 1 || score.recentMisses >= 2;
  const verdict = repromote ? 'repromote' : failed.length ? 'hold' : 'eligible';
  return { verdict, failed, proposal: verdict === 'eligible' && prior?.verdict === 'eligible' };
}

// ---------- command line ----------

const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const flag = (argv, name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };

function toEngineFinding(f, i) {
  const start = Number.isFinite(f.line) ? f.line : null;
  return { src: 'engine', id: f.id ?? `e${i}`, file: f.file, start, end: Number.isFinite(f.lineEnd) ? f.lineEnd : start, sev: lc(f.severity), inDiff: true, title: f.title ?? '', body: f.body ?? '' };
}
export { toEngineFinding };

/** One PR: its rounds, their CR findings, pair state, and (when an engine record exists) the match. */
async function pairsForPr(pr, { gh, git, engine, runJudge, cfg, now, dryRun, kind, band, version, budget, finalKeys = new Set() }) {
  const [pull, data, inline] = await Promise.all([gh(['api', `repos/${REPO}/pulls/${pr}`]), roundData(pr, { gh, repo: REPO }), inlineComments(pr, { gh, repo: REPO })]);
  const rounds = roundsFrom({ ...data, commentEdits: {} });
  const rows = [];
  for (const [i, round] of rounds.entries()) {
    // A final stored row for (pr, sha40, version): no engine call, and no new row, so the write keeps the stored one.
    if (finalKeys.has(`${pr}|${round.sha40}`)) continue;
    const review = data.reviews.find((r) => r.id === round.reviewId);
    const cr = crFindings({ round, review, inline });
    const base = git ? crRange(rounds, i, { git }).base : null;
    const has = () => git(['cat-file', '-e', `${round.sha40}^{commit}`]).status === 0;
    if (git && !has()) git(['fetch', '--quiet', 'fork', `pull/${pr}/head`]); // a sha that is still missing after the fetch is gone
    const shaGone = git ? !has() : false;
    let eng = null;
    // rank: the round's place among the non-notice rounds, the numbering fetchPr and replayRun use.
    const rank = rounds.slice(0, i + 1).filter((r) => !r.notice).length;
    if (!dryRun && !round.notice && engine && budget.left > 0) { budget.left -= 1; eng = await engine({ pr, round: i + 1, rank, sha40: round.sha40, base }); }
    const prInfo = { author: pull.user?.login, merged: Boolean(pull.merged_at), closed: pull.state === 'closed', shaGone };
    const st = pairState({ round, engine: eng, pr: prInfo, now, ttlMs: (cfg.shadow?.ttlHours ?? 12) * 3_600_000 });
    const row = { v: 1, ts: new Date(now).toISOString(), pr, sha40: round.sha40, round: i + 1, kind, band, crBase: base, engineSource: eng ? 'shadow' : null, engineVersion: version, state: st.state, reason: st.reason, paid: false, cr: cr.map(({ id, sev, inDiff, file, start, end }) => ({ id, sev, inDiff, file, start, end })), eng: [], matches: [], crOnly: [], engOnly: [], disputed: [] };
    if (st.state === 'paired') {
      const engF = eng.findings;
      const res = matchFindings(cr, engF, { tol: cfg.shadow?.tol ?? 3 });
      const matches = res.matches.map((m) => ({ crId: m.cr.id, engId: m.eng.id, how: 'line' }));
      const usedE = new Set(res.matches.map((m) => m.eng.id));
      const disputed = [];
      let pending = false;
      for (const j of res.toJudge) {
        const verdict = resolveJudged(await judgeSameIssue({ cr: j.cr, eng: j.candidates[0], hunk: '' }, { runJudge }), { minConfidence: cfg.shadow?.minConfidence ?? 4 });
        if (verdict.kind === 'match') { matches.push({ crId: j.cr.id, engId: j.candidates[0].id, how: 'judge' }); usedE.add(j.candidates[0].id); } else if (verdict.kind === 'disputed') disputed.push(j.cr.id); else if (verdict.kind === 'pending') pending = true;
      }
      Object.assign(row, { eng: engF.map(({ id, sev, inDiff, file, start, end }) => ({ id, sev, inDiff, file, start, end })), matches, disputed, crOnly: res.crOnly.map((f) => f.id), engOnly: engF.filter((f) => !usedE.has(f.id)).map((f) => f.id) });
      if (pending) Object.assign(row, { state: 'engine_pending', reason: 'judge unavailable' });
    }
    rows.push(row);
  }
  return { rows, rounds, pull };
}

const rootOf = (argv, deps) => deps.root ?? flag(argv, '--root', SHADOW_ROOT);
// The checkout this file sits in (scripts/eval/review-eval/ is three levels down). The scheduled task's cwd is not the repo.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The engine a direct CLI run uses: replayRun with kind 'shadow', output under the shadow root.
 * ok -> { sha40, timedOut, failed: false, findings }; failed or tree_unbuildable -> { failed: true }; cap, frozen or refused -> null
 * (no engine record: the round stays engine_pending and a later sync retries it).
 */
export function defaultShadowEngine({ cfg, gh, root, repoRoot = REPO_ROOT, replayRun = realReplayRun }) {
  return async ({ pr, rank, sha40 }) => {
    // The shadow version hashes the old freeze (cursor-review's prompt), so the shadow replay stays on that reviewer.
    const res = await replayRun({ pr, round: rank, set: 'shadow', kind: 'shadow', reviewer: 'cursor-review' }, { root: repoRoot, cfg, gh, outRoot: path.join(root, 'replay'), runsPath: path.join(root, 'runs.jsonl') });
    const at = res.record?.sha40 ?? sha40;
    if (res.status === 'ok') {
      let found = {};
      try { found = JSON.parse(readFileSync(res.findingsPath, 'utf8')); } catch { return { sha40: at, failed: true }; }
      return { sha40: at, timedOut: Boolean(found.timedOut), failed: false, findings: (found.findings ?? []).map(toEngineFinding) };
    }
    if (res.status === 'failed' || res.status === 'tree_unbuildable') return { sha40: at, failed: true, timedOut: /timed out/i.test(String(res.reason ?? '')) };
    return null;
  };
}

export async function main(argv, deps = {}) {
  const [cmd] = argv;
  const out = deps.stdout ?? ((s) => console.log(s));
  const err = deps.stderr ?? ((s) => console.error(s));
  const root = rootOf(argv, deps);
  if (underLocalReview(root)) { err(`shadow: the state root must not sit under local-review: ${root}`); return 2; }
  const cfg = deps.cfg ?? loadConfig();
  const now = (deps.now ?? Date.now)();
  mkdirSync(root, { recursive: true });

  if (cmd === 'retro' || cmd === 'sync') {
    const gh = deps.gh ?? defaultGh;
    if (cmd === 'sync' && !argv.includes('--force')) {
      // Live sync stays off until the retro has 20 paired rows and the P0 judge passed (judge-gate.json { pass: true }).
      const retroPaired = readJsonl(path.join(root, 'pairs.jsonl')).filter((p) => p.kind === 'retro' && p.state === 'paired').length;
      const gate = path.join(root, 'judge-gate.json');
      const judgePass = existsSync(gate) && JSON.parse(readFileSync(gate, 'utf8')).pass === true;
      if (retroPaired < (cfg.shadow?.liveMinPaired ?? 20) || !judgePass) {
        out(`shadow sync is off: ${retroPaired} of ${cfg.shadow?.liveMinPaired ?? 20} retro pairs, judge gate ${judgePass ? 'passed' : 'not passed'}`);
        return 0;
      }
    }
    const from = Number(flag(argv, '--from', cmd === 'sync' ? cfg.shadowFromPr : NaN));
    const toArg = flag(argv, '--to', NaN);
    const to = toArg === 'latest' ? Number((await gh(['api', `repos/${REPO}/pulls?state=all&sort=created&direction=desc&per_page=1`]))[0]?.number) : Number(toArg);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) { err('shadow retro: --from N --to M are required'); return 2; }
    const max = Number(flag(argv, '--max', cfg.shadow?.retroMax ?? 40));
    const dryRun = argv.includes('--dry-run');
    const version = deps.engineVersion ?? engineVersion({ model: 'grok-4.7-high', promptSha256: cfg.freeze?.promptSha256 ?? promptSha256() });
    const budget = { left: max };
    // Injected deps win (tests, callers); a direct CLI run gets the real replay engine, git in this checkout, and the headless judge.
    const repoRoot = deps.repoRoot ?? REPO_ROOT;
    const engine = deps.engine ?? defaultShadowEngine({ cfg, gh, root, repoRoot, replayRun: deps.replayRun });
    const git = deps.git ?? makeGit(repoRoot);
    const runJudge = deps.runJudge ?? (await import('../../lib/headless.mjs')).runJudge;
    const finalKeys = new Set(readJsonl(path.join(root, 'pairs.jsonl')).filter((p) => p.engineVersion === version && FINAL_STATES.has(p.state)).map((p) => `${p.pr}|${p.sha40}`));
    // Spec section 2: sync is live L2, the MID/ELEVATED sample. [Follow-up] L1 kind 'required' (HIGH/CRITICAL or labelled PRs) is not built yet.
    const kind = cmd === 'retro' ? 'retro' : 'sample';
    const all = [];
    const failures = [];
    for (let pr = from; pr <= to; pr += 1) {
      try {
        const { rows } = await pairsForPr(pr, { gh, git, engine, runJudge, cfg, now, dryRun, kind, band: deps.band ?? 'MID', version, budget, finalKeys });
        all.push(...rows);
      } catch (e) { failures.push({ pr, error: String(e.message).slice(0, 200) }); }
    }
    writeFileSync(path.join(root, 'retro-rounds.json'), `${JSON.stringify({ at: new Date(now).toISOString(), from, to, rounds: all.map(({ pr, sha40, round, state, reason }) => ({ pr, sha40, round, state, reason })) }, null, 1)}\n`);
    if (!dryRun) {
      const file = path.join(root, 'pairs.jsonl');
      const keep = readJsonl(file).filter((p) => !all.some((a) => a.pr === p.pr && a.sha40 === p.sha40 && a.engineVersion === p.engineVersion));
      writeFileSync(file, [...keep, ...all].map((r) => `${JSON.stringify(r)}\n`).join(''));
    }
    const counts = Object.fromEntries(PAIR_STATES.map((s) => [s, all.filter((r) => r.state === s).length]));
    const result = { command: cmd, from, to, dryRun, engineVersion: version, rounds: all.length, counts, failures, pairs: all.map(({ pr, round, sha40, state, reason, cr, matches, crOnly, engOnly, disputed }) => ({ pr, round, sha40, state, reason, crFindings: cr.length, matches: matches.length, crOnly: crOnly.length, engOnly: engOnly.length, disputed: disputed.length })) };
    out(argv.includes('--json') ? JSON.stringify(result, null, 1) : `shadow ${cmd}: ${all.length} rounds, ${JSON.stringify(counts)}`);
    return failures.length && all.length === 0 ? 1 : 0;
  }

  if (cmd === 'scorecard' || cmd === 'decide') {
    const pairs = readJsonl(path.join(root, 'pairs.jsonl'));
    const labels = readJsonl(path.join(root, 'labels.jsonl'));
    const week = flag(argv, '--week', isoWeek(new Date(now)));
    const version = flag(argv, '--engine-version', cfg.freeze?.promptSha256 ? engineVersion({ model: 'grok-4.7-high', promptSha256: cfg.freeze.promptSha256 }) : '');
    const holdoutFile = deps.holdoutPath ?? path.join(root, 'holdout.json');
    const holdout = existsSync(holdoutFile) ? JSON.parse(readFileSync(holdoutFile, 'utf8')) : null;
    const dir = path.join(root, 'scorecard');
    mkdirSync(dir, { recursive: true });
    const prevFile = path.join(dir, `${week}.json`);
    const prior = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, 'utf8')) : null;
    const bands = {};
    for (const band of ['MID', 'ELEVATED', 'HIGH', 'CRITICAL']) bands[band] = scoreBand(pairs, labels, { band, engineVersion: version, holdout, bar: cfg.shadow?.bar, prior: prior?.bands?.[band] });
    const card = { v: 1, week, engineVersion: version, bands };
    writeFileSync(prevFile, `${JSON.stringify(card, null, 1)}\n`);
    if (cmd === 'scorecard') { out(argv.includes('--json') ? JSON.stringify(card, null, 1) : `shadow scorecard ${week}: ${Object.entries(bands).map(([b, s]) => `${b} ${s.verdict}`).join(', ')}`); return 0; }
    const band = flag(argv, '--band', 'HIGH');
    const s = bands[band];
    if (!s) { err(`shadow decide: unknown band ${band}`); return 2; }
    appendFileSync(path.join(root, 'decisions.jsonl'), `${JSON.stringify({ ts: new Date(now).toISOString(), week, band, verdict: s.verdict, failed: s.failed })}\n`);
    if (s.verdict === 'repromote') {
      const state = deps.bandStatePath ?? path.join(root, 'band-state.json'); // local-review-shadow/, never the LR-PIN folder (main spec 5.2, 8)
      mkdirSync(path.dirname(state), { recursive: true });
      writeFileSync(state, `${JSON.stringify({ [band]: { mode: 'full', since: new Date(now).toISOString(), reason: 'engine missed real Majors or a security-tier escape' } }, null, 1)}\n`);
      out(`shadow decide ${band}: repromote`);
      return 3;
    }
    out(`shadow decide ${band}: ${s.verdict}${s.failed.length ? ` (${s.failed.join(', ')})` : ''}`);
    return 0;
  }

  err('shadow: use retro | sync | scorecard | decide');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.stack || e.message); process.exit(1); });
}
// foldSev and ghList stay exported for the CLI report.
export { foldSev, ghList };
