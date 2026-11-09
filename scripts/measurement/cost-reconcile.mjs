#!/usr/bin/env node
/**
 * cost-reconcile.mjs - Read-only cost reconcile of Claude Code sessions (method 6.1 and 6.2). Node builtins only.
 *
 * Input: the agent ledger state folder (one <session>.json each) and the transcripts under the projects folder
 * (<project>/<session>.jsonl, subagent files in <session>/subagents/**). The ledger is the `cost-state` records in the main transcript.
 * Output: JSON lines. One `row` per session and model, one `session` per session, `finding` lines, one `summary` last.
 * Two checks:
 *   price check    ledger tokens x prices.json vs ledger costUSD (gate 0.01% on complete non-Haiku rows)
 *   capture check  sliced transcript recompute vs ledger (clean sessions feed the rolling-20 bands)
 *
 * Usage: node scripts/measurement/cost-reconcile.mjs [options]
 *   --projects <dir>     transcripts (default ~/.claude/projects)
 *   --state <dir>        agent ledger state (default ~/.claude/state/agentic-os)
 *   --prices <file>      prices.json (default the plugin's file)
 *   --baseline <file>    capture bands (default scripts/measurement/capture-baseline.json)
 *   --run-state <file>   rolling window and run history (default .claude/cache/cost-reconcile/run-state.json). The only file this script writes
 *                        besides --out.
 *   --no-run-state       read and write no run-state: no band check (research runs)
 *   --out <file>         also write the lines here. The file must be inside --e2e-dir (default .claude/cache/e2e).
 *   --session <prefix>   only sessions whose id starts with this (repeatable)
 *   --sessions <file>    a JSON array of session ids (or of { sid } objects) to use
 *   --since-hours <n>    only sessions whose transcript changed in the last n hours (the nightly run uses 48: it overlaps the last night,
 *                        and the window dedupes by session id)
 *   --min-idle-min <n>   a session changed in the last n minutes is active: reported, held out of the window (default 30)
 *   --replay             replay the clean sessions in date order as nightly runs (per session and per day)
 *   --compare <file>     compare with the research ses_slice.json (per session and model)
 *   --quiet              print only finding and summary lines (--out still holds all lines)
 *   --now <iso>          the clock (tests)
 * Population: the sessions that have a state file in --state (the agentic-os ledger state), not every transcript with cost-state rows.
 *   Headless sessions have no state file and are not checked.
 * Exit: 0 ok. 10 ok with a warn finding. 1 a fail finding (it wins over 10). 2 the inputs cannot be read, or the check saw nothing it could
 *   check: an empty state folder, or no transcript for any state file (a moved or renamed folder). A quiet day, with no session in
 *   the --since-hours window, is exit 0.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkPriceRow, evaluateBands, foldTranscripts, groupLedger, isClean, isHaiku, ledgerModelRows, loadPrices, median, readLedger,
  replayBands, singleSessionLevel, stat, updateWindow, windowSig,
} from './cost-reconcile-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SYNTHETIC = '<synthetic>';
const WARN_EXIT = 10;

class EnvError extends Error {}
const pct = (recompute, ledger) => ((recompute - ledger) / ledger) * 100;

export const defaults = () => ({
  projects: join(homedir(), '.claude', 'projects'),
  state: join(homedir(), '.claude', 'state', 'agentic-os'),
  prices: join(REPO, '.claude', 'plugins', 'ccv3-mods', 'hooks', 'shared', 'prices.json'),
  baseline: join(HERE, 'capture-baseline.json'),
  runState: join(REPO, '.claude', 'cache', 'cost-reconcile', 'run-state.json'),
  e2eDir: join(REPO, '.claude', 'cache', 'e2e'),
  minIdleMin: 30,
});

/** True when `file` is inside `dir`. Case-insensitive on Windows. */
export const isInside = (dir, file) => {
  const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(lower(resolve(dir)), lower(resolve(file)));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

const transcriptIndex = (projects) => {
  const index = new Map();
  if (!existsSync(projects)) throw new EnvError(`the projects folder does not exist: ${projects}`);
  for (const d of readdirSync(projects, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(projects, d.name))) if (f.endsWith('.jsonl')) index.set(f.slice(0, -6), join(projects, d.name, f));
  }
  return index;
};

const subagentFiles = (mainFile) => {
  const root = join(mainFile.slice(0, -6), 'subagents');
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
};

const wantedIds = (o) => {
  const ids = [...(o.sessions ?? [])];
  if (o.sessionsFile) {
    for (const x of JSON.parse(readFileSync(o.sessionsFile, 'utf8'))) ids.push(typeof x === 'string' ? x : x.sid);
  }
  return ids;
};

const readJson = (file, what) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new EnvError(`cannot read ${what} ${file}: ${e.message}`); }
};

const localDay = (d) => d.toLocaleDateString('en-CA');

/** Reconcile one session. Returns { session, rows, findings, checks, sliceInfo } or null when it has no ledger. */
function reconcileSession(prices, base, o, sessionId, mainFile, state, now) {
  const ledgerRows = readLedger(mainFile);
  if (ledgerRows.length === 0) return null;
  const sid = sessionId.slice(0, 8);
  const groups = groupLedger(ledgerRows);
  const totalUsd = groups.reduce((s, g) => s + (g.row.totalCostUSD ?? 0), 0);
  const fold = foldTranscripts(prices, [mainFile, ...subagentFiles(mainFile)], { minMs: Math.min(...groups.map((g) => g.startTime)) });
  const findings = [];
  const find = (level, code, message, extra = {}) => findings.push({ kind: 'finding', level, code, sid, message, ...extra });
  const mtime = statSync(mainFile).mtimeMs;
  const idleMin = (now.getTime() - mtime) / 60_000;
  const clean = isClean({ groups: groups.length, resumed: state?.cache?.resumed, totalUsd, minUsd: base.minCleanUsd });
  const active = idleMin < o.minIdleMin;

  const ledgerByModel = {};
  const checks = [];
  for (const r of ledgerModelRows(groups)) {
    (ledgerByModel[r.model] ??= { usd: 0, rows: [] }).usd += r.costUSD;
    const share = fold.models[r.model]?.c.cw ? fold.models[r.model].c.cw1h / fold.models[r.model].c.cw : 0;
    const fl = fold.flags[r.model];
    const mixed = Boolean(fl && (fl.speed > 0 || fl.geo > 0));
    const res = checkPriceRow(prices, r, { share1h: share, minRowUsd: base.minRowUsd, tolerancePct: base.priceTolerancePct, mixed });
    ledgerByModel[r.model].rows.push(res);
    checks.push(res);
    if (res.status === 'fail') {
      find('fail', res.code, res.code === 'unknown-model' ? `ledger model id ${r.model} is not in prices.json` : `price check: ${r.model} off by ${res.residualPct.toFixed(4)}% (gate ${base.priceTolerancePct}%)`, { model: r.model, residualPct: res.residualPct });
    } else if (res.status === 'unproven') {
      continue; // the rule-unproven warn below names the row; the capture bands judge it
    } else if (res.status === 'repaired' || res.status === 'reported' || res.status === 'warn') {
      find(res.status === 'warn' ? 'warn' : 'info', res.status === 'repaired' ? 'no-split-row' : res.status === 'reported' ? 'haiku-cache-row' : res.code, `${r.model}: ${res.note ?? `residual ${res.residualPct.toFixed(4)}%`}`, { model: r.model, residualPct: res.residualPct });
    }
  }
  const unproven = Object.fromEntries(checks.filter((c) => c.status === 'unproven').map((c) => [c.model, c.residualPct]));
  for (const [model, b] of Object.entries(fold.models)) {
    if (b.unknown && model !== SYNTHETIC && !ledgerByModel[model]) find('fail', 'unknown-model', `transcript model id ${model} is not in prices.json`, { model });
    const f = fold.flags[model];
    if (f && (f.speed > 0 || f.geo > 0)) find('warn', 'rule-unproven', `${model}: ${f.speed} fast-mode and ${f.geo} non-global records; reconcile it on the capture bands, not the 0.01% gate`, { model, speed: f.speed, geo: f.geo, ...(unproven[model] === undefined ? {} : { gateResidualPct: unproven[model] }) });
  }

  const rows = [];
  for (const model of new Set([...Object.keys(ledgerByModel), ...Object.keys(fold.models)])) {
    const ledgerUsd = ledgerByModel[model]?.usd ?? 0;
    const recomputeUsd = fold.models[model]?.usd ?? 0;
    rows.push({
      kind: 'row', sid, sessionId, model, clean, ledgerUsd, recomputeUsd,
      residualPct: ledgerUsd >= base.minRowUsd ? pct(recomputeUsd, ledgerUsd) : null,
      priceChecks: (ledgerByModel[model]?.rows ?? []).map((r) => ({ startTime: r.startTime, status: r.status, residualPct: r.residualPct, remainder: r.remainder, note: r.note, highTierResidualPct: r.highTierResidualPct, allFivePct: r.allFivePct })),
    });
  }
  const recomputeUsd = Object.values(fold.models).reduce((s, b) => s + b.usd, 0);
  const residualPct = totalUsd >= 0.01 ? pct(recomputeUsd, totalUsd) : null;
  const level = clean && residualPct !== null ? singleSessionLevel(base, residualPct) : null;
  if (level) find(level, 'single-session', `clean session capture residual ${residualPct.toFixed(2)}% (info above ${base.singleInfoPct}%, warn above ${base.singleWarnPct}%)`, { residualPct });
  const session = {
    kind: 'session', sid, sessionId, clean, resumed: state?.cache?.resumed ?? null, groups: groups.length, ledgerUsd: totalUsd, recomputeUsd, residualPct,
    firstTs: fold.firstTs, requests: fold.requests, advisorIterations: fold.advisorIterations, idleMin: Math.round(idleMin), active,
  };
  return { session, rows, findings, checks };
}

const modelStats = (rows) => {
  const out = {};
  for (const model of new Set(rows.map((r) => r.model))) {
    const mine = rows.filter((r) => r.model === model && r.residualPct !== null);
    out[model] = { all: stat(mine.map((r) => r.residualPct)), clean: stat(mine.filter((r) => r.clean).map((r) => r.residualPct)) };
  }
  return out;
};

const priceSummary = (allChecks) => {
  const complete = allChecks.filter((c) => !isHaiku(c.model) && (c.status === 'pass' || (c.status === 'fail' && c.code === 'price-mismatch')));
  const abs = complete.map((c) => Math.abs(c.residualPct));
  const repaired = allChecks.filter((c) => c.status === 'repaired');
  const byModel = {};
  for (const m of new Set([...complete, ...repaired].map((c) => c.model))) {
    byModel[m] = stat([...complete, ...repaired].filter((c) => c.model === m).map((c) => c.residualPct));
  }
  const haiku = allChecks.filter((c) => isHaiku(c.model) && c.status !== 'skip-small');
  return {
    complete: { n: complete.length, maxAbsPct: abs.length ? Math.max(...abs) : 0, remainderZero: complete.filter((c) => c.remainder === 0).length, failed: complete.filter((c) => c.status === 'fail').length },
    noSplit: { n: repaired.length, byModel: Object.fromEntries([...new Set(repaired.map((c) => c.model))].map((m) => [m, stat(repaired.filter((c) => c.model === m).map((c) => c.residualPct))])) },
    haiku: {
      noCache: { n: haiku.filter((c) => c.status === 'pass' || c.status === 'warn').length, maxAbsPct: Math.max(0, ...haiku.filter((c) => c.status === 'pass' || c.status === 'warn').map((c) => Math.abs(c.residualPct))) },
      cacheRows: haiku.filter((c) => c.status === 'reported').map((c) => ({ sid: c.sid, residualPct: c.residualPct, highTierResidualPct: c.highTierResidualPct })),
    },
    byModel,
    unproven: { n: allChecks.filter((c) => c.status === 'unproven').length },
    skippedSmall: allChecks.filter((c) => c.status === 'skip-small').length,
  };
};

const compareWithResearch = (file, rows, sessions) => {
  const research = new Map(readJson(file, 'the compare file').map((s) => [s.sid, s]));
  const lines = [];
  let n = 0;
  let differing = 0;
  let maxAbs = 0;
  for (const r of rows) {
    const m = research.get(r.sid)?.models?.[r.model];
    if (!m) continue;
    n += 1;
    const diff = r.recomputeUsd - (m.tr_new ?? 0);
    const ledgerDiff = r.ledgerUsd - (m.led ?? 0);
    if (Math.abs(diff) > 1e-6 || Math.abs(ledgerDiff) > 1e-6) {
      differing += 1;
      maxAbs = Math.max(maxAbs, Math.abs(diff));
      lines.push({ kind: 'compare', sid: r.sid, model: r.model, recomputeUsd: r.recomputeUsd, researchRecomputeUsd: m.tr_new ?? null, ledgerUsd: r.ledgerUsd, researchLedgerUsd: m.led ?? null });
    }
  }
  const missing = sessions.filter((s) => !research.has(s.sid)).map((s) => s.sid);
  return { lines, summary: { rowsCompared: n, rowsDiffering: differing, maxAbsRecomputeDiffUsd: maxAbs, sessionsNotInResearch: missing } };
};

/**
 * Run the whole check. Pure apart from reading the inputs and (with o.runState) writing the run-state file.
 * Returns { lines, exitCode }. Throws EnvError when an input cannot be read.
 */
export function reconcile(o) {
  const prices = loadPrices(o.prices);
  const base = readJson(o.baseline, 'the baseline');
  const now = o.now ?? new Date();
  if (!existsSync(o.state)) throw new EnvError(`the state folder does not exist: ${o.state}`);
  const index = transcriptIndex(o.projects);
  const wanted = wantedIds(o);
  const sinceMs = o.sinceHours ? now.getTime() - o.sinceHours * 3_600_000 : null;

  const lines = [];
  const findings = [];
  const allChecks = [];
  const sessions = [];
  const rows = [];
  const skipped = { noTranscript: 0, noLedger: 0, notSelected: 0 };
  const stateFiles = readdirSync(o.state).filter((n) => n.endsWith('.json')).sort();
  if (stateFiles.length === 0) throw new EnvError(`the state folder holds no session state file: ${o.state}`);
  for (const f of stateFiles) {
    const sessionId = f.slice(0, -5);
    if (wanted.length && !wanted.some((w) => sessionId.startsWith(w))) { skipped.notSelected += 1; continue; }
    const mainFile = index.get(sessionId);
    if (!mainFile) { skipped.noTranscript += 1; continue; }
    if (sinceMs !== null && statSync(mainFile).mtimeMs < sinceMs) { skipped.notSelected += 1; continue; }
    let state = null;
    try { state = JSON.parse(readFileSync(join(o.state, f), 'utf8')); } catch { /* a torn state file: resumed stays unknown */ }
    const r = reconcileSession(prices, base, o, sessionId, mainFile, state, now);
    if (!r) { skipped.noLedger += 1; continue; }
    sessions.push(r.session);
    rows.push(...r.rows);
    findings.push(...r.findings);
    allChecks.push(...r.checks.map((c) => ({ ...c, sid: r.session.sid })));
    lines.push(r.session, ...r.rows);
  }

  if (skipped.noTranscript === stateFiles.length) throw new EnvError(`none of the ${stateFiles.length} state files has a transcript under ${o.projects}`);

  const cleanSessions = sessions.filter((s) => s.clean && s.residualPct !== null);
  const ordered = [...cleanSessions].sort((a, b) => Date.parse(a.firstTs) - Date.parse(b.firstTs));
  const summary = {
    kind: 'summary', at: now.toISOString(), sessions: sessions.length, clean: cleanSessions.length, skipped, minRowUsd: base.minRowUsd,
    byModel: modelStats(rows),
    session: { all: stat(sessions.filter((s) => s.ledgerUsd >= 0.01 && s.residualPct !== null).map((s) => s.residualPct)), clean: stat(cleanSessions.map((s) => s.residualPct)) },
    priceCheck: priceSummary(allChecks),
  };

  if (o.replay) {
    const residuals = ordered.map((s) => s.residualPct);
    const dayEnds = [];
    ordered.forEach((s, i) => { if (i === ordered.length - 1 || s.firstTs.slice(0, 10) !== ordered[i + 1].firstTs.slice(0, 10)) dayEnds.push(i + 1); });
    const brief = (x) => ({ runs: x.steps.length, evaluated: x.steps.filter((s) => s.status !== 'warmup').length, fails: x.fails, warns: x.warns, medianMin: Math.min(...x.steps.filter((s) => s.status !== 'warmup').map((s) => s.median)), medianMax: Math.max(...x.steps.filter((s) => s.status !== 'warmup').map((s) => s.median)) });
    summary.replay = { cleanSessions: residuals.length, overallMedian: residuals.length ? median(residuals) : null, perSession: brief(replayBands(base, residuals)), perDay: brief(replayBands(base, residuals, dayEnds)) };
  } else if (o.runState) {
    const prev = existsSync(o.runState) ? readJson(o.runState, 'the run-state') : { version: 1, window: [], history: [] };
    const settled = cleanSessions.filter((s) => !s.active).map((s) => ({ sid: s.sessionId, firstTs: s.firstTs, residualPct: s.residualPct }));
    const window = updateWindow(prev.window ?? [], settled, base);
    const bands = evaluateBands(base, window.map((w) => w.residualPct), prev.history ?? [], localDay(now), windowSig(window));
    mkdirSync(dirname(o.runState), { recursive: true });
    const tmp = `${o.runState}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: now.toISOString(), window, history: bands.history }, null, 2) + '\n');
    renameSync(tmp, o.runState);
    summary.bands = { status: bands.status, median: bands.median, windowSessions: bands.n, needed: base.window, warnAbove: bands.warnAt, failAbove: bands.failAt, consecutiveOver: bands.consecutiveOver, activeHeldBack: cleanSessions.filter((s) => s.active).length };
    if (bands.status === 'warn' || bands.status === 'fail') {
      findings.push({ kind: 'finding', level: bands.status, code: 'capture-band', message: `rolling-${base.window} median ${bands.median.toFixed(2)}% (baseline ${base.baselineMedianPct}%); ${bands.status === 'fail' ? `over ${bands.failAt} on ${bands.consecutiveOver} runs in a row` : `over ${bands.warnAt}`}` });
    }
  } else {
    summary.bands = { status: 'not-run', reason: 'no run-state' };
  }

  if (o.compare) {
    const c = compareWithResearch(o.compare, rows, sessions);
    lines.push(...c.lines);
    summary.compare = c.summary;
  }
  const failing = findings.filter((f) => f.level === 'fail');
  summary.findings = { fail: failing.length, warn: findings.filter((f) => f.level === 'warn').length, info: findings.filter((f) => f.level === 'info').length };
  summary.status = failing.length ? 'fail' : summary.findings.warn ? 'warn' : 'ok';
  const exitCode = failing.length ? 1 : summary.findings.warn ? WARN_EXIT : 0;
  summary.exitCode = exitCode;
  lines.push(...findings, summary);
  return { lines, exitCode };
}

export function parseArgs(argv) {
  const o = { ...defaults(), sessions: [] };
  const take = (i) => { if (i + 1 >= argv.length) throw new EnvError(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--projects') o.projects = resolve(take(i++));
    else if (a === '--state') o.state = resolve(take(i++));
    else if (a === '--prices') o.prices = resolve(take(i++));
    else if (a === '--baseline') o.baseline = resolve(take(i++));
    else if (a === '--run-state') o.runState = resolve(take(i++));
    else if (a === '--no-run-state') o.runState = null;
    else if (a === '--e2e-dir') o.e2eDir = resolve(take(i++));
    else if (a === '--out') o.out = resolve(take(i++));
    else if (a === '--session') o.sessions.push(take(i++));
    else if (a === '--sessions') o.sessionsFile = resolve(take(i++));
    else if (a === '--since-hours') o.sinceHours = Number(take(i++));
    else if (a === '--min-idle-min') o.minIdleMin = Number(take(i++));
    else if (a === '--compare') o.compare = resolve(take(i++));
    else if (a === '--now') o.now = new Date(take(i++));
    else if (a === '--replay') o.replay = true;
    else if (a === '--quiet') o.quiet = true;
    else throw new EnvError(`unknown option ${a}`);
  }
  return o;
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
    if (o.out && !isInside(o.e2eDir, o.out)) throw new EnvError(`--out must be inside ${o.e2eDir}`);
    const { lines, exitCode } = reconcile(o);
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    if (o.out) {
      mkdirSync(dirname(o.out), { recursive: true });
      writeFileSync(o.out, text);
    }
    process.stdout.write(o.quiet ? lines.filter((l) => l.kind === 'finding' || l.kind === 'summary').map((l) => JSON.stringify(l)).join('\n') + '\n' : text);
    process.exitCode = exitCode;
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    console.error(`ENV: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
