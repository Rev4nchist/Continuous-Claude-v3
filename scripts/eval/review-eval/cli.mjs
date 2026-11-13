#!/usr/bin/env node
// Review eval CLI. Exit 0 ok, 1 failed, 2 refused, 3 cap.
//   freeze                                    record the prompt hash in config.json
//   resolve --dataset F [--out F]             resolve the dataset findings to sha and lines (read-only gh)
//   replay --pr N --round K [--build-only]    replay one round; --all-majors [--build-only] replays every real Major
//   shadow retro|sync|scorecard|decide ...    the shadow protocol (shadow.mjs)
//   judge [--probe]                           one judge call (spends a headless run: the probe is the only caller)
//   labels export --pairs F --dir D | labels ingest --dir D [--out F]
//   score --dir D [--out F] [--rebase A] [--linktype F]   scorecard from runs.jsonl and the dataset; --rebase A reads the findings files from archive A;
//                                             --linktype F reads the linkType labels (default linktype-labels.json beside this file)
//   rescore --archive A --out D [--root R]    re-apply the parser and the path filter to archived raw answers (no model call); then `score --dir D`
//   report --dir D [--report F] [--out F]     the scorecard as a short Markdown table (--report: the Markdown file; --out: the JSON scorecard)
//   budget --dataset F [--ledger F] [--gold-dir D] [--json]   read only: per-phase eval scopes, the phase 4 need and the four cut cases
//   score ... --holdout-spend [--scope P4] [--spend-ledger F]  also write one holdout-spend line per frozen arm
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLedgerPath } from '../../github/cursor-review.mjs';
import { budgetFromFile, EVAL_SCOPES, p4Plan } from './budget.mjs';
import { CONFIG_PATH, judgeModelFor, loadConfig } from './config.mjs';
import { loadDataset, mergeGold, prCounts, realMajors, reserveSources, resolveFindings, setOf, splitSets, zeroMajorPrs } from './dataset.mjs';
import { frozenEngineSha, LEGACY_ENGINE_VERSION, recordEngineFreeze, recordFreeze, recordVersionedFreeze } from './freeze.mjs';
import { GOLD_DIR, loadCleanControls, loadGold } from './gold.mjs';
import { exportPairs, ingestLabels } from './labels.mjs';
import { LINKTYPE_PATH, loadLinkTypes } from './linktype.mjs';
import { makeGit, replayRun as realReplayRun } from './replay.mjs';
import { archiveFile, rescoreArchive, treeCheck } from './rescore.mjs';
import { evaluateRuns, scorecard } from './score.mjs';
import { main as shadowMain } from './shadow.mjs';

const flag = (argv, name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
// A per-ref cap (one ref has used its share of the week) skips that round only; the eval budget and the headroom stop the batch.
const isRefCap = (r) => r.exit === 3 && /^ref-cap\b/.test(String(r.reason ?? ''));
const stopsBatch = (r) => r.exit === 2 || (r.exit === 3 && !isRefCap(r));
const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);

async function loadMajors(argv, io, cfg) {
  if (io.loadFindings) return io.loadFindings();
  const file = flag(argv, '--dataset', null);
  if (!file) throw Object.assign(new Error('--dataset <file> is required'), { code: 'BAD_INPUT' });
  const ds = loadDataset(file);
  const resolved = await resolveFindings(ds, { gh: io.gh, filter: (f) => ['major', 'critical'].includes(String(f.severity).toLowerCase()) && f.verdict === 'real' });
  return splitSets(resolved, cfg).replay.map((f) => ({ ...f, set: setOf(f.pr, cfg) }));
}

async function replayCmd(argv, io, cfg, root) {
  const buildOnly = argv.includes('--build-only');
  const bodyMode = flag(argv, '--body', undefined); // withheld (default in replayRun) or full: whether the engine sees the PR body
  const reviewer = flag(argv, '--reviewer', undefined); // engine (default in replayRun) or cursor-review (the old runReview path)
  const run = io.replayRun ?? realReplayRun;
  const deps = io.replayDeps ?? { root, cfg, gh: io.gh, tmpRoot: flag(argv, '--tmp-root', undefined), ledgerPath: flag(argv, '--ledger', undefined), runsPath: flag(argv, '--runs', undefined), outRoot: flag(argv, '--out-root', undefined) };
  if (argv.includes('--all-majors')) {
    let majors;
    try { majors = await loadMajors(argv, io, cfg); } catch (e) { io.stderr(`replay: ${e.message}`); return e.code === 'BAD_INPUT' ? 2 : 1; }
    const only = flag(argv, '--only', null);
    if (only !== null && !['holdout', 'dev'].includes(only)) { io.stderr(`replay: --only takes holdout or dev, got ${JSON.stringify(only)}`); return 2; }
    const rounds = new Map();
    for (const m of majors.filter((x) => only === null || x.set === only)) rounds.set(`${m.pr}:${m.roundRank ?? m.round}`, { pr: m.pr, round: m.roundRank ?? m.round, set: m.set });
    const results = [];
    for (const r of rounds.values()) {
      const res = await run({ ...r, buildOnly, reviewer, bodyMode }, deps);
      results.push({ pr: r.pr, round: r.round, set: r.set, status: res.status, exit: res.exit, reason: res.reason, files: res.files, range: res.range, base40: res.base40, sha40: res.sha40 });
      if (stopsBatch(res)) { io.stderr(`replay stopped: ${res.status}: ${res.reason}`); break; }
    }
    const okKey = new Set(results.filter((r) => r.exit === 0).map((r) => `${r.pr}:${r.round}`));
    const majorsBuilt = majors.filter((m) => okKey.has(`${m.pr}:${m.roundRank ?? m.round}`)).length;
    const summary = { buildOnly, majors: { total: majors.length, ok: majorsBuilt }, rounds: { total: rounds.size, ok: okKey.size }, results };
    io.stdout(JSON.stringify(summary, null, 1));
    const refused = results.find(stopsBatch);
    if (refused) return refused.exit;
    return results.every((r) => r.exit === 0) ? 0 : 1;
  }
  const pr = Number(flag(argv, '--pr', NaN));
  const round = Number(flag(argv, '--round', NaN));
  if (!Number.isInteger(pr) || !Number.isInteger(round)) { io.stderr('replay: --pr N --round K or --all-majors is required'); return 2; }
  // A reserve PR is the next holdout: it is never replayed. The default set comes from config.json, not 'holdout'.
  const own = setOf(pr, cfg);
  if (own === 'reserve') { io.stderr('replay: the PR is on the reserve list (config.json reserve): a reserve PR is never replayed'); return 2; }
  const res = await run({ pr, round, buildOnly, set: flag(argv, '--set', own), reviewer, bodyMode }, deps);
  io.stdout(JSON.stringify(res, null, 1));
  return res.exit ?? 1;
}

// The model family of each reviewer (both run on Cursor with Grok 4.7 today). A run with no reviewer is an old cursor-review row.
const REVIEWER_FAMILY = Object.freeze({ engine: 'grok', 'cursor-review': 'grok' });
const familyOfRun = (r) => r.family ?? REVIEWER_FAMILY[r.reviewer ?? 'cursor-review'] ?? `unknown (reviewer ${JSON.stringify(r.reviewer)})`;
const versionOfRun = (r) => r.promptVersion ?? LEGACY_ENGINE_VERSION;

export const HOLDOUT_SPEND_PATH = path.join(os.homedir(), '.claude', 'state', 'local-review', 'eval', 'holdout-spend.jsonl');

/** One line per frozen arm with holdout runs: { ts, reviewer, promptVersion, promptSha256, holdoutRuns, scope }. No PR id. */
function holdoutSpendLines(runs, frozenOf, { ts, scope }) {
  const arms = new Map();
  for (const r of runs) {
    const reviewer = r.reviewer ?? 'cursor-review';
    const promptVersion = reviewer === 'engine' ? versionOfRun(r) : null;
    const frozen = frozenOf(reviewer, promptVersion);
    // Only runs that made a model call and that score keeps: status ok, no full-body leak, complete coverage.
    const kept = r.status === 'ok' && r.bodyMode !== 'full' && r.coverageComplete !== false;
    if (r.set !== 'holdout' || !kept || !frozen || r.promptSha256 !== frozen) continue;
    const key = `${reviewer}|${promptVersion}`;
    const arm = arms.get(key) ?? { ts, reviewer, promptVersion, promptSha256: frozen, holdoutRuns: 0, scope };
    arm.holdoutRuns += 1;
    arms.set(key, arm);
  }
  return [...arms.values()];
}

/** spend: true only for `score --holdout-spend`; `report` never writes. */
function scoreCmd(argv, io, cfg, { spend = false } = {}) {
  const dir = flag(argv, '--dir', null);
  if (!dir) { io.stderr('score: --dir <review-eval folder> is required'); return 2; }
  const rebase = flag(argv, '--rebase', null);
  const runs = readJsonl(path.join(dir, 'runs.jsonl')).map((r) => (rebase && r.findingsPath ? { ...r, findingsPath: archiveFile(rebase, r.findingsPath) } : r));
  const datasetFile = path.join(dir, 'dataset-resolved.json');
  if (!existsSync(datasetFile)) { io.stderr(`score: ${datasetFile} is missing: run \`resolve --out\` first`); return 2; }
  // A judge never shares the reviewer family, and there is no default judge: a family with no entry refuses the whole card.
  for (const family of new Set(runs.map(familyOfRun))) {
    try { judgeModelFor(cfg, family); } catch (e) { io.stderr(`score: ${e.message}`); return 2; }
  }
  const engineVersions = [...new Set(runs.filter((r) => r.reviewer === 'engine').map(versionOfRun))];
  if (engineVersions.length > 1) { io.stderr(`score: engine runs of ${engineVersions.join(' and ')} in one folder: score one prompt version at a time`); return 2; }
  const engineSha = frozenEngineSha(cfg, engineVersions[0] ?? LEGACY_ENGINE_VERSION);
  // With no frozen hash, score.mjs cannot mark a row stale, so an unfrozen arm would count as clean holdout.
  if (engineVersions.length === 1 && !engineSha) { io.stderr(`score: no engine freeze for ${engineVersions[0]}: run \`cli.mjs freeze --engine --prompt-version ${engineVersions[0]}\` first`); return 2; }
  const spendScope = flag(argv, '--scope', 'P4');
  if (spend && argv.includes('--holdout-spend') && !EVAL_SCOPES.includes(spendScope)) { io.stderr(`score: --scope takes ${EVAL_SCOPES.join(', ')}`); return 2; }
  const frozenOf = (reviewer, version) => (reviewer === 'engine' ? frozenEngineSha(cfg, version ?? LEGACY_ENGINE_VERSION) : cfg.freeze?.promptSha256 ?? null);
  const resolved = JSON.parse(readFileSync(datasetFile, 'utf8'));
  const ev = evaluateRuns({ runs, dataset: resolved.findings, readFindings: (p) => (p ? JSON.parse(readFileSync(p, 'utf8')) : { findings: [] }) });
  const labels = readJsonl(path.join(dir, 'labels.jsonl'));
  const card = scorecard({ runs: ev.runs, matches: ev.matches, labels, sets: { zeroMajorPrs: resolved.zeroMajorPrs ?? [] }, linkTypes: loadLinkTypes(flag(argv, '--linktype', LINKTYPE_PATH)), frozenByReviewer: { engine: engineSha, 'cursor-review': cfg.freeze?.promptSha256 }, frozenPromptSha256: (runs.some((r) => r.reviewer === 'engine') ? engineSha : cfg.freeze?.promptSha256) ?? null, pairsSent: readJsonl(path.join(dir, 'pairs-sent.jsonl')) });
  const out = flag(argv, '--out', null);
  if (out) { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`); }
  if (spend && argv.includes('--holdout-spend')) {
    // ev.runs: the newest row per round, as score keeps it, so a re-run of one round counts once.
    const lines = holdoutSpendLines(ev.runs, frozenOf, { ts: new Date(io.now?.() ?? Date.now()).toISOString(), scope: spendScope });
    const file = flag(argv, '--spend-ledger', io.spendLedger ?? HOLDOUT_SPEND_PATH);
    if (lines.length > 0) { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join('')); }
    io.stderr(`score: holdout-spend lines written: ${lines.length}`);
  }
  io.stdout(JSON.stringify(card, null, 1));
  return 0;
}

// ---------- budget (map C1, T04, E02): read only ----------

function budgetReport({ cfg, ledger, ds, goldDir, now }) {
  const b = budgetFromFile(ledger, cfg, { now, scope: 'P4' });
  const merged = mergeGold(loadGold(goldDir).rows, cfg);
  const controlsInFile = loadCleanControls(goldDir).length;
  const c = prCounts({ ds, cfg, goldRows: merged.rows });
  const plan = p4Plan({ counts: { controls: controlsInFile, holdout: c.holdout, dev: c.dev, gold: c.gold }, p4: cfg.p4, p4Free: b.scopes.P4.free });
  const split = 'dataset + config.json holdoutExclude';
  const sources = { holdout: split, dev: split, gold: 'gold loader', controls: plan.inputs.controlsPlanned ? `planned (config.json p4.controlsMin; clean-controls.json has ${controlsInFile})` : 'clean-controls.json' };
  return { ledger, scopes: b.scopes, evalUsed: b.evalUsed, globalUsed: b.globalUsed, inputs: { ...plan.inputs, sources, goldBySource: c.goldBySource, goldOverlap: c.goldOverlap, suites: c.suites, reservePrsInDataset: c.reserve, goldSplitDiffers: merged.splitDiffers }, need: plan.need, fits: plan.fits, reserved: cfg.p4.reserved, cases: plan.cases, reserve: reserveSources(cfg) };
}

function budgetText(r) {
  const scope = ([s, v]) => (v.free === 0 ? `${s} ${v.used} used of ${v.cap} (closed)` : `${s} ${v.used} used of ${v.cap}, ${v.free} free`);
  const i = r.inputs;
  const caseLine = (c) => {
    const head = `holdout ${c.holdoutRuns} run${c.holdoutRuns === 1 ? '' : 's'} per arm, winner evidence ${c.winnerStarts} starts: `;
    if (!c.fits) return `- ${head}DOES NOT FIT, short by ${c.shortfall} engine calls (free ${c.freeStarts} starts = ${c.freeCalls} calls; controls ${c.controlsCalls} + holdout ${c.holdoutCalls} calls); gold targets with a call 0 of ${i.gold}`;
    return `- ${head}free ${c.freeStarts} starts = ${c.freeCalls} engine calls; controls ${c.controls} (${c.controlsCalls} calls), holdout PRs ${i.holdout} (${c.holdoutCalls} calls), dev PRs ${c.devTargets} of ${i.dev} (${c.devCalls} calls), gold targets with a call ${c.goldTargets} of ${i.gold}; starts: p4-ab ${c.p4abStarts} + verifier replay ${r.reserved.verifierReplay} + winner evidence ${c.winnerStarts} = ${c.sum}`;
  };
  return [
    `Eval budget (read only; ledger ${r.ledger})`,
    ...Object.entries(r.scopes).map(scope),
    `Global 7-day starts: ${r.globalUsed} (stop at 240)`,
    `Phase 4 inputs (counts only): controls ${i.controls} [${i.sources.controls}], holdout PRs ${i.holdout} [${i.sources.holdout}], dev PRs ${i.dev} [${i.sources.dev}], gold targets ${i.gold} [${i.sources.gold}; ${Object.entries(i.goldBySource).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}]`,
    `Phase 4 need for the full design: ${r.need} starts, beside verifier replay ${r.reserved.verifierReplay} and winner evidence ${r.reserved.winnerEvidence}: ${r.fits ? 'fits' : 'does not fit'} in P4 ${r.scopes.P4.free} free`,
    `Own-repo gold targets left out because their PR is already a holdout or dev PR: ${i.goldOverlap}`,
    `The cut (DP1.16), four cases. Nothing is written; Dave chooses what gives way. It takes the reserved starts whole from P4 ${r.scopes.P4.free} free (it assumes verifier replay and winner evidence have spent none yet):`,
    ...r.cases.map(caseLine),
    `reserve PRs ${r.reserve.total}, with no answer-key source ${r.reserve.noSource}`,
    `dataset PRs with no suite in config.json: ${i.suites.none} of ${i.suites.total} (regression ${i.suites.regression}, capability ${i.suites.capability})`,
    `gold rows whose own split differs from config.json: ${i.goldSplitDiffers}`,
  ].join('\n');
}

function budgetCmd(argv, io, cfg) {
  const dsFile = flag(argv, '--dataset', null);
  if (!dsFile) { io.stderr('budget: --dataset <the CodeRabbit dataset file> is required'); return 2; }
  const r = budgetReport({ cfg, ledger: flag(argv, '--ledger', defaultLedgerPath()), ds: loadDataset(dsFile), goldDir: flag(argv, '--gold-dir', GOLD_DIR), now: io.now?.() ?? Date.now() });
  io.stdout(argv.includes('--json') ? JSON.stringify(r, null, 1) : budgetText(r));
  return 0;
}

/** The real path: follows symlinks and junctions in the nearest existing ancestor, then appends the missing segments. */
function canonical(p) {
  let head = path.resolve(p);
  const rest = [];
  while (!existsSync(head) && path.dirname(head) !== head) { rest.unshift(path.basename(head)); head = path.dirname(head); }
  const real = existsSync(head) ? realpathSync.native(head) : head;
  const full = path.join(real, ...rest);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function rescoreCmd(argv, io, root) {
  const archive = flag(argv, '--archive', null);
  const out = flag(argv, '--out', null);
  if (!archive || !out) { io.stderr('rescore: --archive <review-eval folder> and --out <new folder> are required'); return 2; }
  if (canonical(out) === canonical(archive)) { io.stderr('rescore: --out must be a new folder, never the archive'); return 2; }
  if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length > 0)) { io.stderr(`rescore: --out ${out} exists and is not empty; use a new or empty folder`); return 2; }
  const exists = io.exists ?? treeCheck(makeGit(flag(argv, '--root', root)));
  io.stdout(JSON.stringify(rescoreArchive({ archive, out, exists }), null, 1));
  return 0;
}

export async function main(argv, io = {}) {
  io = { stdout: (s) => console.log(s), stderr: (s) => console.error(s), ...io };
  const [cmd, sub] = argv;
  const root = io.root ?? flag(argv, '--root', process.cwd());
  let cfg;
  try { cfg = io.cfg ?? loadConfig(flag(argv, '--config', CONFIG_PATH)); } catch (e) { io.stderr(`cannot read the config: ${e.message}`); return 2; }
  try {
    switch (cmd) {
      case 'freeze': {
        const promptVersion = flag(argv, '--prompt-version', null);
        if (promptVersion !== null && !argv.includes('--engine')) { io.stderr('freeze: --prompt-version needs --engine'); return 2; }
        const freezeIt = promptVersion !== null ? recordVersionedFreeze : argv.includes('--engine') ? recordEngineFreeze : recordFreeze;
        const f = freezeIt({ git: makeGit(root), cfgPath: flag(argv, '--config', CONFIG_PATH), ...(promptVersion !== null ? { promptVersion } : {}) });
        io.stdout(JSON.stringify(f, null, 1));
        return 0;
      }
      case 'resolve': {
        const ds = loadDataset(flag(argv, '--dataset', ''));
        const findings = await resolveFindings(ds, { gh: io.gh });
        const sets = splitSets(findings, cfg);
        const out = { findings, zeroMajorPrs: zeroMajorPrs(ds), counts: { findings: findings.length, replay: sets.replay.length, holdout: sets.holdout.length, dev: sets.dev.length, reserve: sets.reserve.length, byResolution: Object.fromEntries(['comment', 'round', 'unresolved'].map((k) => [k, findings.filter((f) => f.resolvedBy === k).length])) } };
        const file = flag(argv, '--out', null);
        if (file) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`); }
        io.stdout(JSON.stringify(out.counts, null, 1));
        return realMajors(findings).length > 0 ? 0 : 1;
      }
      case 'replay': return await replayCmd(argv, io, cfg, root);
      case 'shadow': return await shadowMain(argv.slice(1), { cfg, stdout: io.stdout, stderr: io.stderr, gh: io.gh, engine: io.engine, runJudge: io.runJudge, git: io.git, now: io.now, root: io.shadowRoot });
      case 'judge': {
        if (!argv.includes('--probe')) { io.stderr('judge: only --probe is supported'); return 2; }
        const { runJudge } = await import('../../lib/headless.mjs');
        const res = await (io.runJudge ?? runJudge)('Reply with exactly: {"sameIssue":"no","real":"unclear","confidence":1,"reason":"probe"}', { timeoutMs: 120_000 });
        io.stdout(JSON.stringify({ ok: res.ok, reason: res.reason, costUsd: res.costUsd, result: res.result }, null, 1));
        return res.ok ? 0 : res.reason === 'cap' ? 3 : 1;
      }
      case 'labels': {
        const dir = flag(argv, '--dir', null);
        if (!dir) { io.stderr('labels: --dir is required'); return 2; }
        if (sub === 'export') {
          const pairs = JSON.parse(readFileSync(flag(argv, '--pairs', ''), 'utf8'));
          const r = exportPairs(pairs, { dir, week: flag(argv, '--week', undefined), cap: cfg.labelWeekCap, now: io.now?.() });
          io.stdout(JSON.stringify(r));
          return r.ok ? 0 : 2;
        }
        if (sub === 'ingest') {
          const r = ingestLabels(dir, { out: flag(argv, '--out', undefined) });
          io.stdout(JSON.stringify({ rows: r.rows.length, rejected: r.rejected }));
          return 0;
        }
        io.stderr('labels: use export | ingest');
        return 1;
      }
      case 'score': return scoreCmd(argv, io, cfg, { spend: true });
      case 'budget': return budgetCmd(argv, io, cfg);
      case 'rescore': return rescoreCmd(argv, io, root);
      case 'report': {
        let text = '';
        const sink = { ...io, stdout: (s) => { text = s; } };
        const code = scoreCmd(argv, sink, cfg);
        if (code !== 0) return code;
        const c = JSON.parse(text);
        const pct = (r) => (r?.value == null ? 'n/a' : `${(r.value * 100).toFixed(0)}% (${r.found}/${r.total})`);
        const num = (v) => (v == null ? 'n/a' : v.toFixed(2));
        const dropReasons = (by) => (Object.keys(by).length > 0 ? ` (${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ')})` : '');
        const ja = c.judgeAgreement;
        const classRows = (set) => Object.entries(c.perClassRecall?.[set] ?? {}).map(([cls, r]) => `| Same-issue recall, ${set}, ${cls} | ${pct(r)} |`);
        const md = ['# Review eval scorecard', '', '| Metric | Value |', '|---|---|', `| Strict Major recall | ${pct(c.perMajorRecall.strict)} |`, `| Lenient Major recall | ${pct(c.perMajorRecall.lenient)} |`, `| Per-PR recall | ${pct(c.perPrRecall)} |`, `| PR false alarms | ${c.prFalseAlarm.count} of ${c.prFalseAlarm.total} |`, `| Precision real/posted | ${c.precision.value == null ? 'n/a' : c.precision.value.toFixed(2)} |`, `| Same-issue recall, holdout (overall) | ${pct(c.perMajorRecall.strictSameIssue)} |`, ...classRows('holdout'), ...classRows('dev'), `| Funnel, ${c.funnel.runs} run(s) | raw ${c.funnel.raw}, withdrawn ${c.funnel.withdrawn}, dropped ${c.funnel.dropped.total}${dropReasons(c.funnel.dropped.byReason)}, posted ${c.funnel.posted} |`, `| Holdout misses the reviewer withdrew | ${c.withdrawnMisses.inWithdrawn} of ${c.withdrawnMisses.misses} (no data: ${c.withdrawnMisses.noData}) |`, `| Judge agreement | n=${ja.n}, raw ${num(ja.value)}, kappa ${num(ja.kappa)}, ${ja.status} |`, `| Runs, ${c.cost.grok.runs + c.excludedRuns} (${c.excludedRuns} excluded) | body mode: withheld ${c.bodyModes.withheld}, full ${c.bodyModes.full}, unknown ${c.bodyModes.unknown} |`, ''].join('\n');
        const out = flag(argv, '--report', null);
        if (out) writeFileSync(out, md);
        io.stdout(md);
        return 0;
      }
      default:
        io.stderr(`review-eval: unknown command ${JSON.stringify(cmd)}. Use freeze | resolve | replay | shadow | judge | labels | score | budget | rescore | report`);
        return 1;
    }
  } catch (e) {
    io.stderr(`review-eval ${cmd}: ${e.message}`);
    return e.code === 'BAD_INPUT' ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.stack || e.message); process.exit(1); });
}
