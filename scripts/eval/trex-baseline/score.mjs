#!/usr/bin/env node
// Scores the TREX baseline engine runs with the review-eval harness (match.mjs, judge.mjs, score.mjs). Scoring rule:
// .claudedocs/2026-11-03-trex-review-baseline.md. Reads <out>/plan.json and <out>/<runId>/record.json written by run.mjs.
//   node score.mjs --out <dir> [--no-judge] [--max-judge 3]
// Hit = a kept engine finding in a defect file that the harness judge calls the same issue (confidence >= 4). A line match
// (match.mjs, tol 3, where the fix hunk gives old-side lines) decides which findings are judged first; it is not a hit alone.
// Writes <out>/dataset-resolved.json, <out>/runs.jsonl, <out>/findings/<runId>.json (harness shapes), <out>/judge/<row>.json and <out>/results.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runJudge } from '../../lib/headless.mjs';
import { judgeSameIssue } from '../review-eval/judge.mjs';
import { foldSev, matchFindings } from '../review-eval/match.mjs';
import { evaluateRuns, scorecard } from '../review-eval/score.mjs';
import { datasetFindings, findingsFile, majorFindings, normPath, runRow } from './adapter.mjs';
import { buildRows } from './rows.mjs';

const flag = (argv, name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const SEV_RANK = { critical: 4, major: 3, minor: 2, info: 1 };
const lc = (s) => String(s ?? '').toLowerCase();

/** Candidate order for the judge: line-matched findings first, then severity, then confidence, then position. */
export function rankCandidates(candidates, lineMatched) {
  return [...candidates].sort((a, b) => (lineMatched.has(b) - lineMatched.has(a))
    || ((SEV_RANK[lc(b.severity)] ?? 0) - (SEV_RANK[lc(a.severity)] ?? 0))
    || ((b.confidence ?? 3) - (a.confidence ?? 3)) || ((a.line ?? 0) - (b.line ?? 0)));
}

function loadRecord(out, runId) {
  const f = path.join(out, runId, 'record.json');
  return existsSync(f) ? readJson(f) : null;
}

async function judgeRow({ row, cands, out, maxJudge, judge }) {
  const cacheFile = path.join(out, 'judge', `${row.id}.json`);
  const cached = existsSync(cacheFile) ? readJson(cacheFile) : { calls: [] };
  for (const f of cands.slice(0, maxJudge)) {
    const key = `${f.file}:${f.line}:${f.title}`;
    if (cached.calls.some((c) => c.key === key && !c.error && (c.withHunk || (c.same && c.confidence >= 4)))) continue; // a first pass ran without the fix hunk (plan.json dropped it): only its yes >= 4 stands
    cached.calls = cached.calls.filter((c) => c.key !== key || (c.same && c.confidence >= 4 && !c.withHunk) || c.withHunk === true);
    if (cached.calls.some((c) => !c.error && c.same && c.confidence >= 4)) break;
    const cr = { severity: 'major', title: row.fixSubject, body: `${row.fixBody}\n\n(The fix commit above is the ground truth for the seeded defect. The defect is in: ${row.defectFiles.join(', ')}.)` };
    const res = judge ? await judgeSameIssue({ cr, eng: { severity: f.severity, title: f.title, body: f.body }, hunk: row.fixHunk }, { runJudge }) : { error: 'skipped' };
    cached.calls.push({ key, withHunk: Boolean(row.fixHunk), file: f.file, line: f.line, severity: f.severity, title: f.title, ...res });
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify(cached, null, 1)}\n`);
    if (res.error === 'cap') break;
  }
  return cached.calls;
}

export async function main(argv) {
  // runJudge starts `claude -p` through the grok slot gate. The judge is not a grok run, and the engine runs hold the slots, so the gate is off for the judge.
  process.env.CCV3_GROK_GATE = 'off';
  const out = path.resolve(flag(argv, '--out', ''));
  const judge = !argv.includes('--no-judge');
  const maxJudge = Number(flag(argv, '--max-judge', 3));
  const plan = readJson(path.join(out, 'plan.json'));
  const { runs } = plan;
  const git = (a) => spawnSync('git', a, { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).stdout ?? '';
  const fresh = buildRows({ benchDir: flag(argv, '--bench-dir', 'C:/Users/dkhay/continuous-claude/.claude/worktrees/trex/scripts/trex/bench'), git });
  const rows = plan.rows.map((r) => ({ ...r, fixHunk: r.fixHunk ?? fresh.find((x) => x.id === r.id)?.fixHunk }));
  mkdirSync(path.join(out, 'findings'), { recursive: true });

  // Harness shapes: findings files, runs.jsonl, dataset-resolved.json.
  const runLines = [];
  const records = new Map();
  for (const run of runs) {
    const record = loadRecord(out, run.runId);
    records.set(run.runId, record);
    const file = findingsFile(record);
    const findingsPath = path.join(out, 'findings', `${run.runId}.json`);
    if (file) writeFileSync(findingsPath, `${JSON.stringify(file, null, 1)}\n`);
    runLines.push(runRow({ run, record, findingsPath, ts: record?.ts ?? new Date(0).toISOString() }));
  }
  writeFileSync(path.join(out, 'runs.jsonl'), `${runLines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const dataset = datasetFindings(rows, runs);
  writeFileSync(path.join(out, 'dataset-resolved.json'), `${JSON.stringify({ findings: dataset, zeroMajorPrs: runs.filter((r) => r.kind === 'negative').map((r) => r.pr) }, null, 1)}\n`);
  const ev = evaluateRuns({ runs: runLines, dataset, readFindings: readJson });
  const card = scorecard({ runs: ev.runs, matches: ev.matches, sets: { zeroMajorPrs: runs.filter((r) => r.kind === 'negative').map((r) => r.pr) } });

  // Positives: judge the candidates in the defect files.
  const result = { positives: [], negatives: [] };
  for (const row of rows.filter((r) => r.kind === 'positive')) {
    const run = runs.find((r) => r.rowIds.includes(row.id));
    const record = records.get(run.runId);
    const row0 = { id: row.id, run: run.runId, status: record?.status ?? 'no-record', files: row.defectFiles };
    if (!record || record.status !== 'ok') { result.positives.push({ ...row0, hit: false, strictHit: false, note: 'no complete engine record' }); continue; }
    const eng = (record.findings ?? []).map((f) => ({ ...f, file: normPath(f.file), line: f.startLine, severity: lc(f.severity) }));
    const inFile = eng.filter((f) => row.defectFiles.includes(f.file));
    const cr = dataset.filter((d) => d.row === row.id).map((d) => ({ src: 'cr', id: d.key, file: d.path, start: d.startLine, end: d.endLine, sev: 'major' }));
    const m = matchFindings(cr, inFile.map((f, i) => ({ src: 'engine', id: String(i), file: f.file, start: f.startLine, end: f.endLine, sev: f.severity })));
    const lineMatched = new Set(m.matches.map((x) => inFile[Number(x.eng.id)]));
    const calls = inFile.length ? await judgeRow({ row, cands: rankCandidates(inFile, lineMatched), out, maxJudge, judge }) : [];
    const yes = calls.filter((c) => c.same === true && c.confidence >= 4);
    const best = yes.sort((a, b) => (SEV_RANK[lc(b.severity)] ?? 0) - (SEV_RANK[lc(a.severity)] ?? 0))[0];
    const strict = yes.find((c) => ['major', 'critical'].includes(c.severity) && (inFile.find((f) => f.title === c.title)?.confidence ?? 3) >= 3);
    result.positives.push({
      ...row0, engineFindings: eng.length, inDefectFile: inFile.length, lineMatched: lineMatched.size, judgeCalls: calls.length,
      pending: calls.some((c) => c.error), hit: Boolean(best), strictHit: Boolean(strict), severity: best?.severity ?? null, finding: best ? `${best.file}:${best.line} ${best.title}` : null,
      fileOnly: inFile.length > 0,
    });
  }
  // Negatives: every Major or Critical finding (confidence >= 3) is a false alarm.
  for (const run of runs.filter((r) => r.kind === 'negative')) {
    const record = records.get(run.runId);
    if (!record || record.status !== 'ok') { result.negatives.push({ id: run.runId, status: record?.status ?? 'no-record', falseAlarms: null }); continue; }
    const majors = majorFindings((record.findings ?? []).map((f) => ({ ...f, severity: lc(f.severity) })));
    result.negatives.push({ id: run.runId, status: 'ok', findings: record.findings.length, falseAlarms: majors.length, majors: majors.map((f) => `${f.file}:${f.startLine} [${f.severity}] ${f.title}`) });
  }
  const pos = result.positives;
  const neg = result.negatives.filter((n) => n.status === 'ok');
  result.totals = {
    positivesComplete: pos.filter((p) => p.status === 'ok').length, hitsLenient: pos.filter((p) => p.hit).length, hitsStrict: pos.filter((p) => p.strictHit).length,
    fileOnly: pos.filter((p) => p.fileOnly).length, pendingJudge: pos.filter((p) => p.pending).length,
    negativesComplete: neg.length, negativesWithMajor: neg.filter((n) => n.falseAlarms > 0).length, majorFindingsOnNegatives: neg.reduce((a, n) => a + n.falseAlarms, 0),
    harnessLineOnly: { recallLenient: card.devRecall.lenient, recallStrict: card.devRecall.strict },
  };
  writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(result, null, 1)}\n`);
  console.log(JSON.stringify(result.totals, null, 1));
  return 0;
}

void foldSev;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.stack || e.message); process.exit(1); });
}
