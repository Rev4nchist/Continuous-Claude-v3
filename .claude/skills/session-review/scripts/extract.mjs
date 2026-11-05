#!/usr/bin/env node
// session-review extractor. Reads Claude Code transcripts and harness logs (read-only) and writes
// one small digest per session plus inventory.json. The model reads the digests, never a raw
// transcript. Paths are fixed from os.homedir(); only --repo overrides the repo root.
//
// Usage: node extract.mjs [--days 45] [--max-sessions 12] [--session <id-or-prefix>]
//        [--project-prefix C--Users-dkhay-continuous-claude] [--include-headless]
//        [--include-subagents] [--out <dir>] [--repo <dir>]
//        node extract.mjs --append-scores <scores.json>     (trend ledger, fixed path)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { scanFile, evidenceOf, effortOf, sumUsage } from './lib/scan.mjs';
import { redactTruncate } from './lib/redact.mjs';
import { loadLogs, guardFor } from './lib/logs.mjs';
import { readHead, listCandidates, resolveSession } from './lib/files.mjs';
import { factoryOf, subagentFacts } from './lib/factory.mjs';
import { findHandoffs, handoffsFor } from './lib/handoffs.mjs';
import { localStamp, localDate } from './lib/time.mjs';
import { appendScores } from './lib/ledger.mjs';

const DEFAULT_PREFIX = 'C--Users-dkhay-continuous-claude';
const LIVE_MS = 15 * 60000;
const PARSE_ERROR_LIMIT = 0.2;

export function makeCtx({ home = os.homedir(), repo, env = process.env } = {}) {
  const claude = path.join(home, '.claude');
  return {
    home, env, repo: repo || path.join(home, 'continuous-claude'),
    projectsRoot: path.join(claude, 'projects'), logsDir: path.join(claude, 'logs'), stateDir: path.join(claude, 'state'),
  };
}

/** Union-find over file paths: files that share any uuid join one chain. */
function makeShared() {
  const parent = new Map();
  const find = (x) => { if (!parent.has(x)) parent.set(x, x); let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  return { owner: new Map(), link: (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); }, find, parent };
}

function chainsOf(scanned, shared) {
  const groups = new Map();
  for (const f of scanned) {
    const root = shared.find(f.file);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(f);
  }
  const chainOf = new Map();
  const chains = [];
  for (const members of groups.values()) {
    const first = members.reduce((a, b) => (a.order <= b.order ? a : b));
    for (const m of members) chainOf.set(m.file, first.sid);
    if (members.length > 1) chains.push({ chain_id: first.sid, members: members.map((m) => m.sid) });
  }
  return { chainOf, chains };
}

function identityName(ctx, sid) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ctx.stateDir, 'identity', `${sid}.json`), 'utf8'));
    return typeof j.name === 'string' && j.name ? j.name : null;
  } catch { return null; }
}

function labelOf(ctx, S) {
  const name = identityName(ctx, S.sid) || (S.titles.length ? S.titles[S.titles.length - 1] : null);
  const h = `#${S.sid.slice(0, 8)}`;
  return name ? `${redactTruncate(name, 60)} ${h}` : h;
}

function goalCandidates(S, handoffs) {
  const out = [];
  const add = (source, text) => { if (text) out.push({ source, text: redactTruncate(String(text), 400) }); };
  if (S.titles.length) add('custom-title', S.titles[S.titles.length - 1]);
  if (S.aways.length) add('away_summary', S.aways[S.aways.length - 1]);
  for (const h of handoffs.goals) add('handoff', h);
  add('first_prompt', S.firstTyped);
  return out;
}

function costGroup(S) {
  const c = S.cost;
  const tokens = sumUsage(S);
  const mainTotal = tokens.input + tokens.output + tokens.cache_read + tokens.cache_create;
  const group = { source: c ? 'cost-state' : 'unavailable', total_usd: null, by_model: null, hasUnknownModelCost: null, tokens, split: { main: mainTotal, subagent: null, workflow: null, source: 'main-file' } };
  if (!c) return group;
  group.total_usd = typeof c.totalCostUSD === 'number' ? c.totalCostUSD : null;
  group.hasUnknownModelCost = Boolean(c.hasUnknownModelCost);
  group.by_model = {};
  for (const [m, v] of Object.entries(c.modelUsage || {})) group.by_model[m] = typeof v.costUSD === 'number' ? v.costUSD : null;
  return group;
}

function timeGroup(S) {
  const c = S.cost;
  return {
    start_local: localStamp(S.firstTs), end_local: localStamp(S.lastTs),
    start_utc: S.firstTs ? new Date(S.firstTs).toISOString() : null, end_utc: S.lastTs ? new Date(S.lastTs).toISOString() : null,
    active_ms: S.turns > 0 ? S.active : null, wall_ms: c && typeof c.totalDuration === 'number' ? c.totalDuration : null,
    idle_gaps_over_30m: S.idleGaps,
  };
}

function mergeSub(S, sub) {
  for (const sf of sub) {
    for (const [k, v] of Object.entries(sf.calls)) S.calls[k] = (S.calls[k] || 0) + v;
    for (const k of Object.keys(S.errors)) S.errors[k] += sf.errors[k];
    for (const k of Object.keys(S.denials)) S.denials[k] += sf.denials[k];
    for (const [k, v] of Object.entries(sf.hookMs)) { S.hookMs[k] = (S.hookMs[k] || 0) + v; S.hookRuns[k] = (S.hookRuns[k] || 0) + sf.hookRuns[k]; }
    S.blocks.push(...sf.blocks);
  }
}

async function buildDigest(S, ctx, logs, handoffList, chainId, opts, folderDir) {
  let split = null;
  const sid = S.sid;
  if (opts.includeSubagents) {
    const sub = await subagentFacts(path.join(folderDir, sid, 'subagents'));
    mergeSub(S, sub.facts);
    split = { subagent: sub.subagentTokens, workflowStreamed: sub.workflowTokens };
  }
  const fac = factoryOf(path.join(folderDir, sid), logs, sid);
  const cost = costGroup(S);
  if (split) { cost.split.subagent = split.subagent; cost.split.workflow = split.workflowStreamed; cost.split.source = 'streamed-subagents'; }
  else { cost.split.workflow = fac.workflowTokensReported; cost.split.source = 'main-file+wf-json'; }
  const ho = handoffsFor(handoffList, S);
  const ev = evidenceOf(S);
  ev.handoff_outcome = ho.outcome;
  for (const b of S.blocks) { b.guard = guardFor(logs, sid, b); }
  const live = !S.cost && (Date.now() - S.mtimeMs) < LIVE_MS;
  return {
    sid, label: labelOf(ctx, S), chain_id: chainId, folder: path.basename(folderDir),
    cwd: [...S.cwds], branches: [...S.branches], entrypoint: S.entrypoint, permission_modes: [...S.modes], prs: [...S.prs], partial: live,
    goal_candidates: goalCandidates(S, ho),
    time: timeGroup(S), cost,
    context: { compactions: S.compactions, lines_added: S.cost && typeof S.cost.totalLinesAdded === 'number' ? S.cost.totalLinesAdded : null, lines_removed: S.cost && typeof S.cost.totalLinesRemoved === 'number' ? S.cost.totalLinesRemoved : null },
    humans: { human_turns: S.humanTurns, prompts: S.prompts },
    tools: { calls_by_name: S.calls, errors_by_class: S.errors, denials: S.denials, ...effortOf(S) },
    hooks: {
      blocks: S.blocks.map(({ agent_id, ...b }) => (agent_id ? { ...b, agent_id } : b)), hook_ms_by_name: S.hookMs, hook_runs_by_name: S.hookRuns,
      hook_non_blocking_errors: S.hookNonBlocking, hook_non_blocking_count: S.hookNonBlockingCount, rule_router_fires: logs.routerFor(sid),
    },
    asks: { ask_dialog_latency_ms: logs.asksFor(sid) },
    factory: { agents: fac.agents, agents_total: fac.agentsTotal, workflows: fac.workflows, task_notifications: S.taskNotes, review_ledger: logs.reviewFor(sid), coderabbit_rounds: logs.coderabbitFor(sid), attribution_skills: S.attr },
    evidence: ev,
    session_models: [...S.models],
    quality: { parse_errors: S.parseErrors, dup_uuids_dropped: S.dupUuids },
  };
}

function skipReason(S, opts) {
  if (S.reviewRun || S.attr['session-review']) return 'review_run';
  const headlessKept = opts.includeHeadless && S.entrypoint === 'sdk-cli';
  if (S.humanTurns === 0 && !headlessKept) return 'no_human';
  return null;
}

/** Scan candidates in first-timestamp order so the earliest file of a resume chain owns shared records. */
async function scanAll(cands, ctx, opts) {
  const skipped = [];
  const live = [];
  for (const c of cands) {
    if (!opts.session && ctx.env.CLAUDE_CODE_SESSION_ID && c.sid === ctx.env.CLAUDE_CODE_SESSION_ID) { skipped.push({ sid: c.sid, reason: 'self' }); continue; }
    c.head = readHead(c.file);
    if (!opts.session && !opts.includeHeadless && c.head.entrypoint === 'sdk-cli') { skipped.push({ sid: c.sid, reason: 'headless' }); continue; }
    live.push(c);
  }
  live.sort((a, b) => (a.head.firstTs - b.head.firstTs) || (a.mtimeMs - b.mtimeMs) || a.sid.localeCompare(b.sid));
  const shared = opts.session ? null : makeShared();
  const scanned = [];
  for (const [order, c] of live.entries()) {
    const S = await scanFile(c.file, { shared });
    Object.assign(S, { mtimeMs: c.mtimeMs, order, folderDir: path.dirname(c.file) });
    scanned.push(S);
  }
  return { scanned, skipped, shared };
}

export async function run(opts, ctx) {
  const prefix = opts.projectPrefix || DEFAULT_PREFIX;
  const cutoff = Date.now() - (opts.days ?? 45) * 864e5;
  const cands = opts.session ? resolveSession(ctx.projectsRoot, prefix, opts.session) : listCandidates(ctx.projectsRoot, prefix, cutoff);
  const { scanned, skipped, shared } = await scanAll(cands, ctx, opts);
  const { chainOf, chains } = shared ? chainsOf(scanned, shared) : { chainOf: new Map(), chains: [] };
  const eligible = [];
  for (const S of scanned) {
    const why = opts.session ? null : skipReason(S, opts);
    if (why) skipped.push({ sid: S.sid, reason: why }); else eligible.push(S);
  }
  eligible.sort((a, b) => (b.lastTs ?? b.mtimeMs) - (a.lastTs ?? a.mtimeMs));
  const cap = Math.max(1, opts.maxSessions ?? 12);
  const picked = eligible.slice(0, cap);
  const logs = loadLogs(ctx, new Set(picked.map((s) => s.sid)));
  const handoffList = findHandoffs(ctx.repo);
  const digests = [];
  for (const S of picked) digests.push(await buildDigest(S, ctx, logs, handoffList, chainOf.get(S.file) || S.sid, opts, S.folderDir));
  const withErrors = scanned.filter((s) => s.parseErrors > 0).length;
  const inventory = {
    run_ts: new Date().toISOString(), sessions_sampled: digests.length, sessions: digests.map((d) => ({ sid: d.sid, label: d.label, chain_id: d.chain_id })),
    sessions_skipped: skipped, overflow_count: eligible.length - picked.length, files_with_parse_errors: withErrors, files_scanned: scanned.length,
    chains, report_path: path.join(ctx.repo, '.claudedocs', `${localDate(Date.now())}-session-review.md`),
    ledger_path: path.join(ctx.repo, '.claude', 'cache', 'session-review', 'scores.jsonl'),
    stop_reason: null,
  };
  if (digests.length === 0) inventory.stop_reason = 'sessions_sampled == 0';
  else if (scanned.length && withErrors / scanned.length > PARSE_ERROR_LIMIT) inventory.stop_reason = `parse errors in ${withErrors} of ${scanned.length} files (over 20%)`;
  return { inventory, digests };
}

function writeOut(res, outDir) {
  // Digests hold session prompts. Create the folder owner-only. An existing folder that group or others
  // can access is refused. Windows has no POSIX modes, so the mode bits are not checked there.
  const existed = fs.existsSync(outDir);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (existed && process.platform !== 'win32' && (fs.statSync(outDir).mode & 0o077) !== 0) {
    throw new Error(`--out folder ${outDir} is accessible to group or others; use a private folder`);
  }
  for (const d of res.digests) fs.writeFileSync(path.join(outDir, `${d.sid}.json`), JSON.stringify(d), { mode: 0o600 });
  fs.writeFileSync(path.join(outDir, 'inventory.json'), JSON.stringify(res.inventory, null, 1), { mode: 0o600 });
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv, strict: true,
    options: {
      days: { type: 'string' }, 'max-sessions': { type: 'string' }, session: { type: 'string' }, 'project-prefix': { type: 'string' },
      'include-headless': { type: 'boolean' }, 'include-subagents': { type: 'boolean' }, out: { type: 'string' }, repo: { type: 'string' },
      'append-scores': { type: 'string' },
    },
  });
  return {
    days: values.days ? Number(values.days) : 45, maxSessions: values['max-sessions'] ? Number(values['max-sessions']) : 12,
    session: values.session || null, projectPrefix: values['project-prefix'] || DEFAULT_PREFIX,
    includeHeadless: Boolean(values['include-headless']), includeSubagents: Boolean(values['include-subagents']),
    out: values.out || null, repo: values.repo || null, appendScores: values['append-scores'] || null,
  };
}

function harnessSha(repo) {
  try { return execFileSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const ctx = makeCtx({ repo: opts.repo || undefined });
  if (opts.appendScores) {
    const r = appendScores(ctx, opts.appendScores, harnessSha(ctx.repo));
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return 0;
  }
  const res = await run(opts, ctx);
  const outDir = opts.out ? path.resolve(opts.out) : path.join(os.tmpdir(), `session-review-${stamp()}`);
  writeOut(res, outDir);
  const inv = res.inventory;
  const reasons = {};
  for (const s of inv.sessions_skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
  process.stdout.write(`session-review extract: sampled ${inv.sessions_sampled}, skipped ${JSON.stringify(reasons)}, overflow ${inv.overflow_count}, chains ${inv.chains.length}\nout: ${outDir}\n`);
  if (inv.stop_reason) { process.stdout.write(`STOP: ${inv.stop_reason}\n`); return 3; }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { process.stderr.write(`session-review extract failed: ${e && e.message}\n`); process.exitCode = 2; });
}
