// Trend ledger: <repo>/.claude/cache/session-review/scores.jsonl (gitignored by "cache/").
// The path is fixed from the repo root. It is never a CLI argument.
import fs from 'node:fs';
import path from 'node:path';

const REGRESSION_DROP = 0.1;

export const ledgerPath = (ctx) => path.join(ctx.repo, '.claude', 'cache', 'session-review', 'scores.jsonl');

function readLedger(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}

export function meansOf(rows) {
  const sums = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.scores || {})) {
      if (typeof v !== 'number') continue; // null is N/A and stays out of every mean
      (sums[k] ||= []).push(v);
    }
  }
  return Object.fromEntries(Object.entries(sums).map(([k, a]) => [k, Number((a.reduce((x, y) => x + y, 0) / a.length).toFixed(3))]));
}

function validate(rows) {
  for (const r of rows) {
    if (!r || typeof r.sid !== 'string' || typeof r.scores !== 'object' || r.scores === null) throw new Error('each row needs sid and scores');
    for (const [k, v] of Object.entries(r.scores)) if (v !== null && !(typeof v === 'number' && v >= 0 && v <= 1)) throw new Error(`score ${k} must be 0..1 or null`);
  }
}

const sameSet = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

/** Append one line per session; return the previous run's means and any regression flags. */
export function appendScores(ctx, inputFile, sha) {
  const parsed = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.sessions;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('no sessions in scores file');
  validate(rows);
  const file = ledgerPath(ctx);
  const prior = readLedger(file);
  const runTs = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = rows.map((r) => JSON.stringify({ run_ts: runTs, sid: r.sid, chain_id: r.chain_id ?? r.sid, scores: r.scores, session_models: r.session_models ?? [], judge_model: r.judge_model ?? null, harness_sha: sha }));
  fs.appendFileSync(file, lines.join('\n') + '\n');
  const lastTs = prior.map((r) => r.run_ts).sort().at(-1);
  const prev = lastTs ? prior.filter((r) => r.run_ts === lastTs) : [];
  const cur = meansOf(rows.map((r) => ({ scores: r.scores })));
  const prevMeans = meansOf(prev);
  const prevModels = [...new Set(prev.flatMap((r) => r.session_models || []))];
  const curModels = [...new Set(rows.flatMap((r) => r.session_models || []))];
  const changed = [];
  if (prev.length && prev[0].harness_sha !== sha) changed.push('harness_sha');
  if (prev.length && !sameSet(prevModels, curModels)) changed.push('session_models');
  const regressions = [];
  for (const [k, v] of Object.entries(cur)) {
    const p = prevMeans[k];
    if (typeof p === 'number' && p - v > REGRESSION_DROP && changed.length) regressions.push({ scorer: k, previous: p, current: v, delta: Number((v - p).toFixed(3)), changed });
  }
  return { appended: rows.length, run_ts: runTs, ledger: file, previous_run: prev.length ? { run_ts: lastTs, means: prevMeans, harness_sha: prev[0].harness_sha, session_models: prevModels } : null, current_means: cur, regressions };
}
