// Harness logs joined to sessions. Read-only. The log paths are fixed, never CLI arguments.
import fs from 'node:fs';
import path from 'node:path';
import { redactTruncate } from './redact.mjs';

const GUARD_WINDOW_MS = 5000;
const CAP = 50;

function readRows(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a cut last line is normal in a live log */ }
  }
  return rows;
}

function group(rows, field, sids) {
  const m = new Map();
  for (const r of rows) {
    const k = r[field];
    if (typeof k !== 'string' || !sids.has(k)) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

export function loadLogs(ctx, sids) {
  const L = ctx.logsDir, S = ctx.stateDir;
  const guard = group(readRows(path.join(L, 'guard-decisions.jsonl')), 'session_id', sids);
  const router = group(readRows(path.join(L, 'rule-router.jsonl')), 'session', sids);
  const asks = group(readRows(path.join(S, 'ccv3-mods', 'ask-dialogs.jsonl')), 'session', sids);
  const review = group([...readRows(path.join(S, 'cursor-review-ledger.jsonl')), ...readRows(path.join(S, 'headless-review-ledger.jsonl'))], 'sessionId', sids);
  const paid = group(readRows(path.join(S, 'coderabbit-paid.jsonl')), 'session', sids);
  return {
    guard,
    routerFor: (sid) => (router.get(sid) || []).slice(0, CAP).map((r) => ({ ts: r.ts, rules: r.rules, kind: r.kind, tool: r.tool, what: redactTruncate(String(r.what || ''), 80) })),
    asksFor: (sid) => (asks.get(sid) || []).map((r) => r.elapsedMs).filter((n) => typeof n === 'number'),
    reviewFor: (sid) => (review.get(sid) || []).filter((r) => r.phase === 'end').slice(0, CAP).map((r) => ({ model: r.model, band: r.band, pr: r.pr, durationMs: r.durationMs, exit: r.exit, findingCount: r.findingCount, usage: r.usage })),
    coderabbitFor: (sid) => (paid.get(sid) || []).map((r) => ({ date: r.date, pr: r.pr, files: r.files, cost: r.cost })),
  };
}

/** Guard name for a hook block: same session, same tool, a deny within 5 s. Else "unknown". */
export function guardFor(logs, sid, block) {
  const t = Date.parse(block.ts);
  if (Number.isNaN(t)) return 'unknown';
  let best = null;
  for (const r of logs.guard.get(sid) || []) {
    if (r.tool !== block.tool) continue;
    if (block.agent_id ? r.agent_id !== block.agent_id : Boolean(r.agent_id)) continue;
    if (!/^(deny|block)/i.test(String(r.decision || ''))) continue;
    const dt = Math.abs(Date.parse(r.ts) - t);
    if (dt <= GUARD_WINDOW_MS && (!best || dt < best.dt)) best = { dt, hook: r.hook };
  }
  return best && best.hook ? best.hook : 'unknown';
}
