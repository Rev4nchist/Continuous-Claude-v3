#!/usr/bin/env node
// Review eval CLI. Exit 0 ok, 1 failed, 2 refused, 3 cap.
//   freeze                                    record the prompt hash in config.json
//   resolve --dataset F [--out F]             resolve the dataset findings to sha and lines (read-only gh)
//   replay --pr N --round K [--build-only]    replay one round; --all-majors [--build-only] replays every real Major
//   shadow retro|sync|scorecard|decide ...    the shadow protocol (shadow.mjs)
//   judge [--probe]                           one judge call (spends a headless run: the probe is the only caller)
//   labels export --pairs F --dir D | labels ingest --dir D [--out F]
//   score --dir D [--out F]                   scorecard from runs.jsonl and the dataset
//   report --dir D [--out F]                  the scorecard as a short Markdown table
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, loadConfig } from './config.mjs';
import { loadDataset, realMajors, resolveFindings, splitSets, zeroMajorPrs } from './dataset.mjs';
import { recordFreeze } from './freeze.mjs';
import { exportPairs, ingestLabels } from './labels.mjs';
import { makeGit, replayRun as realReplayRun } from './replay.mjs';
import { evaluateRuns, scorecard } from './score.mjs';
import { main as shadowMain } from './shadow.mjs';

const flag = (argv, name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);

async function loadMajors(argv, io, cfg) {
  if (io.loadFindings) return io.loadFindings();
  const file = flag(argv, '--dataset', null);
  if (!file) throw Object.assign(new Error('--dataset <file> is required'), { code: 'BAD_INPUT' });
  const ds = loadDataset(file);
  const resolved = await resolveFindings(ds, { gh: io.gh, filter: (f) => ['major', 'critical'].includes(String(f.severity).toLowerCase()) && f.verdict === 'real' });
  return splitSets(resolved, cfg).replay.map((f) => ({ ...f, set: (cfg.holdoutExclude ?? []).includes(f.pr) ? 'dev' : 'holdout' }));
}

async function replayCmd(argv, io, cfg, root) {
  const buildOnly = argv.includes('--build-only');
  const run = io.replayRun ?? realReplayRun;
  const deps = io.replayDeps ?? { root, cfg, gh: io.gh, tmpRoot: flag(argv, '--tmp-root', undefined), ledgerPath: flag(argv, '--ledger', undefined), runsPath: flag(argv, '--runs', undefined), outRoot: flag(argv, '--out-root', undefined) };
  if (argv.includes('--all-majors')) {
    let majors;
    try { majors = await loadMajors(argv, io, cfg); } catch (e) { io.stderr(`replay: ${e.message}`); return e.code === 'BAD_INPUT' ? 2 : 1; }
    const rounds = new Map();
    for (const m of majors) rounds.set(`${m.pr}:${m.roundRank ?? m.round}`, { pr: m.pr, round: m.roundRank ?? m.round, set: m.set });
    const results = [];
    for (const r of rounds.values()) {
      const res = await run({ ...r, buildOnly }, deps);
      results.push({ pr: r.pr, round: r.round, set: r.set, status: res.status, exit: res.exit, reason: res.reason, files: res.files, range: res.range, base40: res.base40, sha40: res.sha40 });
      if (res.exit === 2 || res.exit === 3) { io.stderr(`replay stopped: ${res.status}: ${res.reason}`); break; }
    }
    const okKey = new Set(results.filter((r) => r.exit === 0).map((r) => `${r.pr}:${r.round}`));
    const majorsBuilt = majors.filter((m) => okKey.has(`${m.pr}:${m.roundRank ?? m.round}`)).length;
    const summary = { buildOnly, majors: { total: majors.length, ok: majorsBuilt }, rounds: { total: rounds.size, ok: okKey.size }, results };
    io.stdout(JSON.stringify(summary, null, 1));
    const refused = results.find((r) => r.exit === 2 || r.exit === 3);
    if (refused) return refused.exit;
    return results.every((r) => r.exit === 0) ? 0 : 1;
  }
  const pr = Number(flag(argv, '--pr', NaN));
  const round = Number(flag(argv, '--round', NaN));
  if (!Number.isInteger(pr) || !Number.isInteger(round)) { io.stderr('replay: --pr N --round K or --all-majors is required'); return 2; }
  const res = await run({ pr, round, buildOnly, set: flag(argv, '--set', 'holdout') }, deps);
  io.stdout(JSON.stringify(res, null, 1));
  return res.exit ?? 1;
}

function scoreCmd(argv, io, cfg) {
  const dir = flag(argv, '--dir', null);
  if (!dir) { io.stderr('score: --dir <review-eval folder> is required'); return 2; }
  const runs = readJsonl(path.join(dir, 'runs.jsonl'));
  const datasetFile = path.join(dir, 'dataset-resolved.json');
  if (!existsSync(datasetFile)) { io.stderr(`score: ${datasetFile} is missing: run \`resolve --out\` first`); return 2; }
  const resolved = JSON.parse(readFileSync(datasetFile, 'utf8'));
  const ev = evaluateRuns({ runs, dataset: resolved.findings, readFindings: (p) => JSON.parse(readFileSync(p, 'utf8')) });
  const labels = readJsonl(path.join(dir, 'labels.jsonl'));
  const card = scorecard({ runs: ev.runs, matches: ev.matches, labels, sets: { zeroMajorPrs: resolved.zeroMajorPrs ?? [] }, frozenPromptSha256: cfg.freeze?.promptSha256 ?? null, pairsSent: readJsonl(path.join(dir, 'pairs-sent.jsonl')) });
  const out = flag(argv, '--out', null);
  if (out) { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`); }
  io.stdout(JSON.stringify(card, null, 1));
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
        const f = recordFreeze({ git: makeGit(root), cfgPath: flag(argv, '--config', CONFIG_PATH) });
        io.stdout(JSON.stringify(f, null, 1));
        return 0;
      }
      case 'resolve': {
        const ds = loadDataset(flag(argv, '--dataset', ''));
        const findings = await resolveFindings(ds, { gh: io.gh });
        const sets = splitSets(findings, cfg);
        const out = { findings, zeroMajorPrs: zeroMajorPrs(ds), counts: { findings: findings.length, replay: sets.replay.length, holdout: sets.holdout.length, dev: sets.dev.length, byResolution: Object.fromEntries(['comment', 'round', 'unresolved'].map((k) => [k, findings.filter((f) => f.resolvedBy === k).length])) } };
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
      case 'score': return scoreCmd(argv, io, cfg);
      case 'report': {
        let text = '';
        const sink = { ...io, stdout: (s) => { text = s; } };
        const code = scoreCmd(argv, sink, cfg);
        if (code !== 0) return code;
        const c = JSON.parse(text);
        const pct = (r) => (r?.value == null ? 'n/a' : `${(r.value * 100).toFixed(0)}% (${r.found}/${r.total})`);
        const md = ['# Review eval scorecard', '', '| Metric | Value |', '|---|---|', `| Strict Major recall | ${pct(c.perMajorRecall.strict)} |`, `| Lenient Major recall | ${pct(c.perMajorRecall.lenient)} |`, `| Per-PR recall | ${pct(c.perPrRecall)} |`, `| PR false alarms | ${c.prFalseAlarm.count} of ${c.prFalseAlarm.total} |`, `| Precision real/posted | ${c.precision.value == null ? 'n/a' : c.precision.value.toFixed(2)} |`, `| Judge agreement | ${c.judgeAgreement.n} pairs, gate ${c.judgeAgreement.pass ? 'passed' : 'not passed'} |`, ''].join('\n');
        const out = flag(argv, '--report', null);
        if (out) writeFileSync(out, md);
        io.stdout(md);
        return 0;
      }
      default:
        io.stderr(`review-eval: unknown command ${JSON.stringify(cmd)}. Use freeze | resolve | replay | shadow | judge | labels | score | report`);
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
